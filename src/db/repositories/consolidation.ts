import { createHash } from "node:crypto";
import { newId } from "@/core/ids";
import type { ConsolidationKind, ConsolidationStatus } from "@/core/vocab";
import type { ConsolidationCandidate, ConsolidationProposal, NewCandidate } from "@/core/types";
import { BaseRepo } from "@/db/repositories/base";

// The consolidation queue aggregate. Detection (in the daemon's
// ConsolidationWorker) inserts candidates here; the auto path or the
// consolidate_apply tool resolves them. This repo owns ONLY the queue's CRUD —
// the detection queries and the writes that apply a candidate (new semantic node,
// supersede, invalidate) live in their consuming slices, on the repos that own
// those aggregates. No SQL leaks into tools.

const CANDIDATE_COLS =
  "id, kind, status, project, member_ids, canonical_id, score, proposal, detected_at, resolved_at, resolved_by";

interface CandidateRow {
  id: string;
  kind: string;
  status: string;
  project: string | null;
  member_ids: string;
  canonical_id: string | null;
  score: number;
  proposal: string | null;
  detected_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

// Idempotency key: a cluster is the same regardless of member order, so hash the
// kind with the sorted ids. Re-detecting an existing cluster (pending, applied, or
// dismissed) collides on UNIQUE(member_hash) and is ignored — never re-proposed.
export function candidateHash(kind: ConsolidationKind, memberIds: string[]): string {
  const key = `${kind}\0${[...memberIds].sort().join("\0")}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

// Canonical orientation for a symmetric pair, so (a,b) and (b,a) dedupe to one key and
// one stored edge (graph expansion via neighborsOf is symmetric, so one direction suffices).
function pairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

function toCandidate(r: CandidateRow): ConsolidationCandidate {
  return {
    id: r.id,
    kind: r.kind as ConsolidationKind,
    status: r.status as ConsolidationStatus,
    project: r.project,
    member_ids: JSON.parse(r.member_ids) as string[],
    canonical_id: r.canonical_id,
    score: r.score,
    proposal: r.proposal != null ? (JSON.parse(r.proposal) as ConsolidationProposal) : null,
    detected_at: r.detected_at,
    resolved_at: r.resolved_at,
    resolved_by: r.resolved_by,
  };
}

export class ConsolidationRepo extends BaseRepo {
  // Enqueue a detected candidate. Idempotent by (kind, members): a duplicate hash is
  // ignored and returns null (no new row); otherwise returns the new candidate's id.
  insertCandidate(input: NewCandidate): string | null {
    const id = newId();
    const hash = candidateHash(input.kind, input.member_ids);
    const info = this.tx(() =>
      this.db
        .prepare(
          `INSERT OR IGNORE INTO consolidation_candidates
             (id, kind, status, project, member_ids, member_hash, canonical_id, score, proposal, detected_at)
           VALUES (@id, @kind, 'pending', @project, @member_ids, @member_hash, @canonical_id, @score, @proposal, @detected_at)`,
        )
        .run({
          id,
          kind: input.kind,
          project: input.project ?? null,
          member_ids: JSON.stringify(input.member_ids),
          member_hash: hash,
          canonical_id: input.canonical_id ?? null,
          score: input.score,
          proposal: input.proposal != null ? JSON.stringify(input.proposal) : null,
          detected_at: input.detected_at,
        }),
    );
    return info.changes > 0 ? id : null;
  }

  // True if a candidate for this exact cluster already exists in any status — so
  // detection can skip the work before building a proposal.
  candidateExists(kind: ConsolidationKind, memberIds: string[]): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM consolidation_candidates WHERE member_hash = ?")
      .get(candidateHash(kind, memberIds));
    return row !== undefined;
  }

  // Pending distill/merge candidates that still need a *judged* proposal — either none
  // at all, or one drafted before the provider produced recommendations. The backlog a
  // newly-enabled provider backfills (e.g. after switching manual -> http).
  pendingNeedingProposal(limit: number): ConsolidationCandidate[] {
    return (
      this.db
        .prepare(
          `SELECT ${CANDIDATE_COLS} FROM consolidation_candidates
           WHERE status = 'pending' AND kind IN ('distill','merge')
             AND (proposal IS NULL OR json_extract(proposal, '$.recommendation') IS NULL)
           ORDER BY score DESC, detected_at ASC LIMIT ?`,
        )
        .all(limit) as CandidateRow[]
    ).map(toCandidate);
  }

  // Attach (or overwrite) a generated proposal on a still-pending candidate. A queue-row
  // write, not a content revision. No-op once the candidate is resolved.
  setCandidateProposal(id: string, proposal: ConsolidationProposal): boolean {
    const info = this.tx(() =>
      this.db
        .prepare(
          "UPDATE consolidation_candidates SET proposal = ? WHERE id = ? AND status = 'pending'",
        )
        .run(JSON.stringify(proposal), id),
    );
    return info.changes > 0;
  }

  getCandidate(id: string): ConsolidationCandidate | undefined {
    const r = this.db
      .prepare(`SELECT ${CANDIDATE_COLS} FROM consolidation_candidates WHERE id = ?`)
      .get(id) as CandidateRow | undefined;
    return r ? toCandidate(r) : undefined;
  }

  pendingCandidates(opts?: { kind?: ConsolidationKind; limit?: number }): ConsolidationCandidate[] {
    const limit = opts?.limit ?? 50;
    const rows = opts?.kind
      ? (this.db
          .prepare(
            `SELECT ${CANDIDATE_COLS} FROM consolidation_candidates
             WHERE status = 'pending' AND kind = ? ORDER BY score DESC, detected_at ASC LIMIT ?`,
          )
          .all(opts.kind, limit) as CandidateRow[])
      : (this.db
          .prepare(
            `SELECT ${CANDIDATE_COLS} FROM consolidation_candidates
             WHERE status = 'pending' ORDER BY score DESC, detected_at ASC LIMIT ?`,
          )
          .all(limit) as CandidateRow[]);
    return rows.map(toCandidate);
  }

  // ---- detection: similar_to link discovery ---------------------------------
  // Deterministic, provider-free: kNN over the already-stored chunk vectors. Returns
  // canonical (src < dst) pairs above `minScore` that don't already have a similar_to
  // edge — ready for the worker to write as system edges (auto) or queue (suggest).

  // Embedded, valid semantic nodes, newest first — the seeds for link and merge discovery.
  // Newest-first so the batch cap never permanently starves recently-written nodes.
  private linkableNodes(limit: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT n.id AS id
           FROM nodes n
           JOIN chunks c ON c.node_id = n.id AND c.stale = 0
           JOIN embedding_meta em ON em.chunk_id = c.id
           WHERE n.memory_kind = 'semantic' AND n.invalidated_at IS NULL
           ORDER BY n.id DESC LIMIT ?`,
        )
        .all(limit) as { id: string }[]
    ).map((r) => r.id);
  }

  // Embedded, valid episodics with no live edge — orphaned records (e.g. a checkpoint
  // written without touched_node_ids) that link discovery reconnects to their nearest
  // semantic neighbors. Newest first; a node drops out of this set once it gains an edge.
  private orphanEpisodics(limit: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT n.id AS id
           FROM nodes n
           JOIN chunks c ON c.node_id = n.id AND c.stale = 0
           JOIN embedding_meta em ON em.chunk_id = c.id
           WHERE n.memory_kind = 'episodic' AND n.invalidated_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM edges e
               WHERE e.invalidated_at IS NULL AND (e.src = n.id OR e.dst = n.id)
             )
           ORDER BY n.id DESC LIMIT ?`,
        )
        .all(limit) as { id: string }[]
    ).map((r) => r.id);
  }

  // Nearest valid semantic neighbors of one node, seeded by its lowest-seq embedded
  // chunk vector (best distance per neighbor node), excluding the node itself.
  private nearestSemantic(
    nodeId: string,
    k: number,
    cap: number,
  ): { id: string; distance: number }[] {
    return this.db
      .prepare(
        `WITH knn AS (
           SELECT chunk_id, distance FROM chunk_vec
           WHERE embedding MATCH (
             SELECT cv.embedding FROM chunks c JOIN chunk_vec cv ON cv.chunk_id = c.id
             WHERE c.node_id = @node AND c.stale = 0 ORDER BY c.seq LIMIT 1
           ) AND k = @k
         )
         SELECT n.id AS id, MIN(knn.distance) AS distance
         FROM knn
         JOIN chunks c ON c.id = knn.chunk_id
         JOIN nodes n ON n.id = c.node_id
         WHERE n.id != @node AND n.memory_kind = 'semantic' AND n.invalidated_at IS NULL
         GROUP BY n.id ORDER BY distance ASC LIMIT @cap`,
      )
      .all({ node: nodeId, k, cap }) as { id: string; distance: number }[];
  }

  similarLinkCandidates(opts: {
    minScore: number;
    k?: number;
    capPerNode?: number;
    limit: number;
  }): { src: string; dst: string; score: number }[] {
    const k = opts.k ?? 20;
    const cap = opts.capPerNode ?? 10;
    const existing = new Set(
      (
        this.db.prepare("SELECT src, dst FROM edges WHERE type = 'similar_to'").all() as {
          src: string;
          dst: string;
        }[]
      ).map((e) => pairKey(e.src, e.dst)),
    );
    const seen = new Set<string>();
    const out: { src: string; dst: string; score: number }[] = [];
    const seeds = [...this.linkableNodes(opts.limit), ...this.orphanEpisodics(opts.limit)];
    for (const id of seeds) {
      for (const nb of this.nearestSemantic(id, k, cap)) {
        const score = 1 - nb.distance;
        if (score < opts.minScore) continue;
        const key = pairKey(id, nb.id);
        if (existing.has(key) || seen.has(key)) continue;
        seen.add(key);
        const [src, dst] = id < nb.id ? [id, nb.id] : [nb.id, id];
        out.push({ src, dst, score });
      }
    }
    return out;
  }

  // ---- detection: episodic clustering for distillation ----------------------
  // Clusters of decayed, not-yet-consolidated episodics that are mutually similar
  // within a project — the raw material a generation provider rolls into one fact.

  // Content of specific nodes (latest revision), in the given order — the inputs the
  // provider distills. Skips ids that no longer exist.
  candidateInputs(ids: string[]): { id: string; title: string; content: string }[] {
    const stmt = this.db.prepare(
      `SELECT n.title AS title,
              (SELECT content FROM revisions WHERE node_id = n.id ORDER BY rev DESC LIMIT 1) AS content
       FROM nodes n WHERE n.id = ?`,
    );
    const out: { id: string; title: string; content: string }[] = [];
    for (const id of ids) {
      const r = stmt.get(id) as { title: string; content: string } | undefined;
      if (r) out.push({ id, title: r.title, content: r.content });
    }
    return out;
  }

  // Embedded episodics eligible to distill: valid, not yet consolidated, and older than
  // the cutoff (decayed enough to be worth rolling up).
  private eligibleEpisodics(
    cutoff: string,
    limit: number,
  ): { id: string; project: string | null }[] {
    return this.db
      .prepare(
        `SELECT DISTINCT n.id AS id, n.project AS project
         FROM nodes n
         JOIN chunks c ON c.node_id = n.id AND c.stale = 0
         JOIN embedding_meta em ON em.chunk_id = c.id
         WHERE n.memory_kind = 'episodic' AND n.invalidated_at IS NULL
           AND n.consolidated_at IS NULL AND n.valid_from <= @cutoff
         ORDER BY n.id LIMIT @limit`,
      )
      .all({ cutoff, limit }) as { id: string; project: string | null }[];
  }

  // Nearest eligible episodic neighbors of one node within the same project.
  private nearestEpisodic(
    nodeId: string,
    project: string | null,
    cutoff: string,
    k: number,
    cap: number,
  ): { id: string; distance: number }[] {
    return this.db
      .prepare(
        `WITH knn AS (
           SELECT chunk_id, distance FROM chunk_vec
           WHERE embedding MATCH (
             SELECT cv.embedding FROM chunks c JOIN chunk_vec cv ON cv.chunk_id = c.id
             WHERE c.node_id = @node AND c.stale = 0 ORDER BY c.seq LIMIT 1
           ) AND k = @k
         )
         SELECT n.id AS id, MIN(knn.distance) AS distance
         FROM knn
         JOIN chunks c ON c.id = knn.chunk_id
         JOIN nodes n ON n.id = c.node_id
         WHERE n.id != @node AND n.memory_kind = 'episodic' AND n.invalidated_at IS NULL
           AND n.consolidated_at IS NULL AND n.valid_from <= @cutoff AND n.project IS @project
         GROUP BY n.id ORDER BY distance ASC LIMIT @cap`,
      )
      .all({ node: nodeId, project, cutoff, k, cap }) as { id: string; distance: number }[];
  }

  // Connected components (over the >= minScore similarity graph) of eligible episodics,
  // keeping only components of at least minCluster. `score` is the mean similarity of
  // the edges that formed the component.
  staleEpisodicClusters(opts: {
    minScore: number;
    minCluster: number;
    cutoff: string;
    limit: number;
    k?: number;
    capPerNode?: number;
  }): { project: string | null; member_ids: string[]; score: number }[] {
    const k = opts.k ?? 20;
    const cap = opts.capPerNode ?? 10;
    const eligible = this.eligibleEpisodics(opts.cutoff, opts.limit);
    const projectOf = new Map(eligible.map((e) => [e.id, e.project]));
    const parent = new Map(eligible.map((e) => [e.id, e.id]));
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      let c = x;
      while (parent.get(c) !== r) {
        const next = parent.get(c)!;
        parent.set(c, r);
        c = next;
      }
      return r;
    };
    const edges: { a: string; b: string; sim: number }[] = [];
    for (const e of eligible) {
      for (const nb of this.nearestEpisodic(e.id, e.project, opts.cutoff, k, cap)) {
        if (!projectOf.has(nb.id)) continue;
        const sim = 1 - nb.distance;
        if (sim < opts.minScore) continue;
        parent.set(find(e.id), find(nb.id));
        edges.push({ a: e.id, b: nb.id, sim });
      }
    }
    const members = new Map<string, string[]>();
    for (const id of parent.keys()) {
      const root = find(id);
      (members.get(root) ?? members.set(root, []).get(root)!).push(id);
    }
    const out: { project: string | null; member_ids: string[]; score: number }[] = [];
    for (const [root, ids] of members) {
      if (ids.length < opts.minCluster) continue;
      const sims = edges.filter((e) => find(e.a) === root).map((e) => e.sim);
      const score = sims.length ? sims.reduce((s, x) => s + x, 0) / sims.length : opts.minScore;
      out.push({ project: projectOf.get(ids[0]!) ?? null, member_ids: ids.sort(), score });
    }
    return out;
  }

  // ---- detection: semantic dedup / merge ------------------------------------
  // Near-duplicate valid semantic pairs above a (higher) merge threshold, with a chosen
  // survivor. Excludes pairs already in a supersedes relationship.

  private hasSupersedes(a: string, b: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM edges WHERE type = 'supersedes'
           AND ((src = @a AND dst = @b) OR (src = @b AND dst = @a)) LIMIT 1`,
        )
        .get({ a, b }) !== undefined
    );
  }

  // Survivor heuristic: the node with more valid edges wins; ties break to the more
  // recent, then the lexicographically smaller id (stable).
  private chooseSurvivor(a: string, b: string): { survivor: string; loser: string } {
    const rank = this.db.prepare(
      `SELECT (SELECT COUNT(*) FROM edges e WHERE (e.src = n.id OR e.dst = n.id) AND e.invalidated_at IS NULL) AS edges,
              n.valid_from AS valid_from
       FROM nodes n WHERE n.id = ?`,
    );
    const ra = rank.get(a) as { edges: number; valid_from: string };
    const rb = rank.get(b) as { edges: number; valid_from: string };
    let survivor: string;
    if (rb.edges !== ra.edges) survivor = rb.edges > ra.edges ? b : a;
    else if (rb.valid_from !== ra.valid_from) survivor = rb.valid_from > ra.valid_from ? b : a;
    else survivor = a < b ? a : b;
    return { survivor, loser: survivor === a ? b : a };
  }

  duplicateSemanticPairs(opts: {
    minScore: number;
    limit: number;
    k?: number;
    capPerNode?: number;
  }): { member_ids: string[]; canonical_id: string; project: string | null; score: number }[] {
    const k = opts.k ?? 20;
    const cap = opts.capPerNode ?? 10;
    const projectOf = this.db.prepare("SELECT project FROM nodes WHERE id = ?");
    const seen = new Set<string>();
    const out: {
      member_ids: string[];
      canonical_id: string;
      project: string | null;
      score: number;
    }[] = [];
    for (const id of this.linkableNodes(opts.limit)) {
      for (const nb of this.nearestSemantic(id, k, cap)) {
        const score = 1 - nb.distance;
        if (score < opts.minScore) continue;
        const key = pairKey(id, nb.id);
        if (seen.has(key)) continue;
        seen.add(key);
        if (this.hasSupersedes(id, nb.id)) continue;
        const { survivor } = this.chooseSurvivor(id, nb.id);
        const project = (projectOf.get(survivor) as { project: string | null }).project;
        const [a, b] = id < nb.id ? [id, nb.id] : [nb.id, id];
        out.push({ member_ids: [a, b], canonical_id: survivor, project, score });
      }
    }
    return out;
  }

  // ---- detection: Tier-1 mirror prune ---------------------------------------
  // Dead mirror nodes to soft-invalidate: valid `symbol` mirrors whose (repo, path) is
  // no longer in the code index (orphaned — a removed file that left symbols dangling).
  // A reconciliation safety net (removeFile normally keeps these in sync). Touches only
  // memory_kind='mirror'; authored memory is never a candidate. (External mirror records
  // from a retired source are a natural future addition here.)
  deadMirrorNodes(limit: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT n.id AS id
           FROM nodes n
           JOIN symbols sy ON sy.node_id = n.id
           WHERE n.memory_kind = 'mirror' AND n.invalidated_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM code_files cf WHERE cf.repo = sy.repo AND cf.path = sy.path
             )
           LIMIT ?`,
        )
        .all(limit) as { id: string }[]
    ).map((r) => r.id);
  }

  // ---- detection: write-time attribute enrichment ---------------------------
  // Valid semantic nodes whose CURRENT revision has no annotation yet — the un-enriched
  // backlog the sweep annotates. Deterministic, provider-free, no embedding dependency
  // (annotation reads only title+content). Newest first, so freshly-written nodes are
  // enriched before they are likely to be searched. A later `update` bumps the rev, whose
  // new (node_id, rev) is again absent here, so the node is naturally re-annotated.
  unannotatedSemantic(
    limit: number,
  ): { id: string; rev: number; title: string; content: string; project: string | null }[] {
    return this.db
      .prepare(
        `SELECT n.id AS id, lr.rev AS rev, n.title AS title, lr.content AS content, n.project AS project
         FROM nodes n
         JOIN (SELECT node_id, MAX(rev) AS mrev FROM revisions GROUP BY node_id) m ON m.node_id = n.id
         JOIN revisions lr ON lr.node_id = n.id AND lr.rev = m.mrev
         LEFT JOIN revision_annotations ra ON ra.node_id = n.id AND ra.rev = lr.rev
         WHERE n.memory_kind = 'semantic' AND n.invalidated_at IS NULL AND ra.node_id IS NULL
         ORDER BY n.valid_from DESC LIMIT ?`,
      )
      .all(limit) as {
      id: string;
      rev: number;
      title: string;
      content: string;
      project: string | null;
    }[];
  }

  // Move a candidate off 'pending'. A queue-state write, not a content revision, so
  // it updates in place. No-op (returns false) if the id is unknown or already resolved.
  resolveCandidate(
    id: string,
    status: Exclude<ConsolidationStatus, "pending">,
    resolvedBy: string,
    ts: string,
  ): boolean {
    const info = this.tx(() =>
      this.db
        .prepare(
          `UPDATE consolidation_candidates SET status = ?, resolved_at = ?, resolved_by = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(status, ts, resolvedBy, id),
    );
    return info.changes > 0;
  }
}
