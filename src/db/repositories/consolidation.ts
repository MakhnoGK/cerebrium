import { createHash } from "node:crypto";
import { injectable } from "tsyringe";
import type {
  ConsolidationReporter,
  ConsolidationTickResult,
} from "@/domain/ports/consolidation-reporter";
import { BaseRepo } from "@/db/repositories/base";
import { LATEST_REVISION } from "@/db/repositories/internal";
import { newId } from "@/core/ids";
import type { ConsolidationCandidate, ConsolidationProposal, NewCandidate } from "@/core/types";
import { ConsolidationKind, ConsolidationStatus, MemoryKind } from "@/core/vocab";

// The consolidation queue aggregate. Detection (in the daemon's
// ConsolidationWorker) inserts candidates here; the auto path or the
// consolidate_apply tool resolves them. This repo owns ONLY the queue's CRUD —
// the detection queries and the writes that apply a candidate (new semantic node,
// supersede, invalidate) live in their consuming slices, on the repos that own
// those aggregates. No SQL leaks into tools.

const CANDIDATE_COLS =
  "id, kind, status, project, member_ids, canonical_id, score, proposal, detected_at, resolved_at, resolved_by, attempts, last_error";

export interface SweepSeed {
  id: string;
  kind: MemoryKind;
  ordinal: number;
}

export interface DuplicatePair {
  member_ids: string[];
  canonical_id: string;
  project: string | null;
  score: number;
  same_session: boolean;
  youngest_created_at: string;
}

interface Provenance {
  session: string;
  created_at: string;
}

interface CandidateRow {
  id: string;
  kind: ConsolidationKind;
  status: string;
  project: string | null;
  member_ids: string;
  canonical_id: string | null;
  score: number;
  proposal: string | null;
  detected_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  attempts: number;
  last_error: string | null;
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
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

function toCandidate(r: CandidateRow): ConsolidationCandidate {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status as ConsolidationStatus,
    project: r.project,
    member_ids: JSON.parse(r.member_ids) as string[],
    canonical_id: r.canonical_id,
    score: r.score,
    proposal: r.proposal != null ? (JSON.parse(r.proposal) as ConsolidationProposal) : null,
    detected_at: r.detected_at,
    resolved_at: r.resolved_at,
    resolved_by: r.resolved_by,
    attempts: r.attempts,
    last_error: r.last_error,
  };
}

@injectable()
export class ConsolidationRepo extends BaseRepo implements ConsolidationReporter {
  // Enqueue a detected candidate. Idempotent by (kind, members): a duplicate hash is
  // ignored and returns null (no new row); otherwise returns the new candidate's id.
  insertCandidate(input: NewCandidate): string | null {
    const id = newId();
    const hash = candidateHash(input.kind, input.member_ids);
    const info = this.tx(() =>
      this.db
        .prepare(
          `INSERT
          OR IGNORE INTO consolidation_candidates
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

  // `id ASC` is not decoration: score and detected_at are not unique together, and a
  // keyset cursor over a non-total order skips or repeats rows at every page boundary.
  // How many candidates are waiting for a decision. Counted rather than listed: this is
  // asked on every tool call.
  pendingCandidateCount(): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM consolidation_candidates WHERE status = 'pending'")
        .get() as { n: number }
    ).n;
  }

  private static readonly PENDING_ORDER = "ORDER BY score DESC, detected_at ASC, id ASC";

  pendingCandidates(opts?: { kind?: ConsolidationKind; limit?: number }): ConsolidationCandidate[] {
    const limit = opts?.limit ?? 50;
    const rows = opts?.kind
      ? (this.db
          .prepare(
            `SELECT ${CANDIDATE_COLS} FROM consolidation_candidates
             WHERE status = 'pending' AND kind = ? ${ConsolidationRepo.PENDING_ORDER} LIMIT ?`,
          )
          .all(opts.kind, limit) as CandidateRow[])
      : (this.db
          .prepare(
            `SELECT ${CANDIDATE_COLS} FROM consolidation_candidates
             WHERE status = 'pending' ${ConsolidationRepo.PENDING_ORDER} LIMIT ?`,
          )
          .all(limit) as CandidateRow[]);
    return rows.map(toCandidate);
  }

  // One page of the pending queue in that same total order, starting strictly after
  // `after` when given. The comparison is spelled out rather than done with a row value
  // because the sort mixes directions: score descends while the tiebreakers ascend.
  pendingCandidatePage(opts: {
    kind?: ConsolidationKind;
    limit: number;
    after?: { score: number; detected_at: string; id: string };
  }): ConsolidationCandidate[] {
    const where = ["status = 'pending'"];
    const params: unknown[] = [];

    if (opts.kind !== undefined) {
      where.push("kind = ?");
      params.push(opts.kind);
    }

    if (opts.after !== undefined) {
      where.push(
        `(score < ?
          OR (score = ? AND detected_at > ?)
          OR (score = ? AND detected_at = ? AND id > ?))`,
      );
      params.push(
        opts.after.score,
        opts.after.score,
        opts.after.detected_at,
        opts.after.score,
        opts.after.detected_at,
        opts.after.id,
      );
    }

    const rows = this.db
      .prepare(
        `SELECT ${CANDIDATE_COLS} FROM consolidation_candidates
         WHERE ${where.join(" AND ")} ${ConsolidationRepo.PENDING_ORDER} LIMIT ?`,
      )
      .all(...params, opts.limit) as CandidateRow[];

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

  // The kNN seed: a node's lowest-seq chunk vector. Null when the node has no vector yet —
  // the seed sets gate on `embedding_meta`, which can outrun the `chunk_vec` row.
  // vec0 aborts the statement on a NULL query vector, so callers must skip instead of MATCH.
  // `chunk_vec` and not `code_vec`: every consolidation seed is authored memory, and a code
  // symbol reaching here would return null rather than a wrong vector.
  private seedVector(nodeId: string): Buffer | null {
    const row = this.db
      .prepare(
        `SELECT cv.embedding AS embedding FROM chunks c JOIN chunk_vec cv ON cv.chunk_id = c.id
         WHERE c.node_id = ? AND c.stale = 0 ORDER BY c.seq LIMIT 1`,
      )
      .get(nodeId) as { embedding: Buffer } | undefined;

    return row?.embedding ?? null;
  }

  // Nearest valid semantic neighbors of one node, seeded by its lowest-seq embedded
  // chunk vector (best distance per neighbor node), excluding the node itself.
  private nearestSemantic(
    nodeId: string,
    k: number,
    cap: number,
  ): { id: string; distance: number }[] {
    const seed = this.seedVector(nodeId);

    if (!seed) {
      return [];
    }

    return this.db
      .prepare(
        `WITH knn AS (
           SELECT chunk_id, distance FROM chunk_vec
           WHERE embedding MATCH @seed AND k = @k
         )
         SELECT n.id AS id, MIN(knn.distance) AS distance
         FROM knn
         JOIN chunks c ON c.id = knn.chunk_id
         JOIN nodes n ON n.id = c.node_id
         WHERE n.id != @node AND n.memory_kind = 'semantic' AND n.invalidated_at IS NULL
         GROUP BY n.id ORDER BY distance ASC LIMIT @cap`,
      )
      .all({ node: nodeId, seed, k, cap }) as { id: string; distance: number }[];
  }

  // The seed set for one sweep: newest embedded semantic nodes, then embedded episodics
  // with no live edge. `ordinal` is the seed's position within its own kind, which is what
  // lets one scan serve two stages with different batch budgets.
  sweepSeeds(limit: number): SweepSeed[] {
    return [
      ...this.linkableNodes(limit).map((id, ordinal) => ({
        id,
        kind: MemoryKind.SEMANTIC,
        ordinal,
      })),
      ...this.orphanEpisodics(limit).map((id, ordinal) => ({
        id,
        kind: MemoryKind.EPISODIC,
        ordinal,
      })),
    ];
  }

  // One seed's semantic neighbours above `minScore`, as similarity rather than distance.
  neighboursOf(
    seedId: string,
    opts: { minScore: number; k?: number; capPerNode?: number },
  ): { id: string; score: number }[] {
    return this.nearestSemantic(seedId, opts.k ?? 20, opts.capPerNode ?? 10)
      .map((nb) => ({ id: nb.id, score: 1 - nb.distance }))
      .filter((nb) => nb.score >= opts.minScore);
  }

  // Every `similar_to` pair already stored, invalidated ones included: a pair retired by
  // the degree cap must not be rediscovered on the next sweep and added back.
  storedSimilarPairs(): Set<string> {
    return new Set(
      (
        this.db.prepare("SELECT src, dst FROM edges WHERE type = 'similar_to'").all() as {
          src: string;
          dst: string;
        }[]
      ).map((e) => pairKey(e.src, e.dst)),
    );
  }

  // ---- detection: similar_to degree control ---------------------------------
  // Discovery gates on an absolute score with no notion of how many neighbors a node
  // already has, so degree grows with every sweep. These two bound it: `linkDegrees`
  // stops new edges at the cap, `overCapSimilarLinks` retires the excess already stored.

  // Live similar_to degree of each id, counted over the same graph search expansion and
  // the UI see: live edges between live non-mirror nodes.
  linkDegrees(ids: string[]): Map<string, number> {
    const out = new Map<string, number>(ids.map((id) => [id, 0]));

    if (!ids.length) {
      return out;
    }

    const ph = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT id, count(*) AS degree FROM (
           SELECT e.src AS id FROM edges e
           JOIN nodes d ON d.id = e.dst AND d.memory_kind != 'mirror' AND d.invalidated_at IS NULL
           WHERE e.type = 'similar_to' AND e.invalidated_at IS NULL AND e.src IN (${ph})
           UNION ALL
           SELECT e.dst AS id FROM edges e
           JOIN nodes s ON s.id = e.src AND s.memory_kind != 'mirror' AND s.invalidated_at IS NULL
           WHERE e.type = 'similar_to' AND e.invalidated_at IS NULL AND e.dst IN (${ph})
         ) GROUP BY id`,
      )
      .all(...ids, ...ids) as { id: string; degree: number }[];

    for (const r of rows) out.set(r.id, r.degree);

    return out;
  }

  // Live system similar_to edges outside the top `maxDegree` by weight of BOTH their
  // endpoints, worst first. The either-endpoint rule is what keeps every node's own best
  // neighbors: a strict per-node cut would strand a node whose best links are not
  // reciprocated, which is how nodes fall out of the graph entirely.
  overCapSimilarLinks(opts: { maxDegree: number; limit: number }): { src: string; dst: string }[] {
    return this.db
      .prepare(
        `WITH live AS (
           SELECT id FROM nodes WHERE memory_kind != 'mirror' AND invalidated_at IS NULL
         ),
         se AS (
           SELECT e.src AS src, e.dst AS dst, e.weight AS weight FROM edges e
           JOIN live s ON s.id = e.src
           JOIN live d ON d.id = e.dst
           WHERE e.type = 'similar_to' AND e.provenance = 'system' AND e.invalidated_at IS NULL
         ),
         dir AS (
           SELECT src AS node, dst AS other, weight FROM se
           UNION ALL
           SELECT dst AS node, src AS other, weight FROM se
         ),
         rk AS (
           SELECT node, other,
                  ROW_NUMBER() OVER (PARTITION BY node ORDER BY weight DESC, other ASC) AS r
           FROM dir
         )
         SELECT se.src AS src, se.dst AS dst, MIN(rk.r) AS best_rank
         FROM se
         JOIN rk ON (rk.node = se.src AND rk.other = se.dst)
                 OR (rk.node = se.dst AND rk.other = se.src)
         GROUP BY se.src, se.dst
         HAVING best_rank > @maxDegree
         ORDER BY best_rank DESC LIMIT @limit`,
      )
      .all({ maxDegree: opts.maxDegree, limit: opts.limit }) as { src: string; dst: string }[];
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
    const seed = this.seedVector(nodeId);

    if (!seed) {
      return [];
    }

    return this.db
      .prepare(
        `WITH knn AS (
           SELECT chunk_id, distance FROM chunk_vec
           WHERE embedding MATCH @seed AND k = @k
         )
         SELECT n.id AS id, MIN(knn.distance) AS distance
         FROM knn
         JOIN chunks c ON c.id = knn.chunk_id
         JOIN nodes n ON n.id = c.node_id
         WHERE n.id != @node AND n.memory_kind = 'episodic' AND n.invalidated_at IS NULL
           AND n.consolidated_at IS NULL AND n.valid_from <= @cutoff AND n.project IS @project
         GROUP BY n.id ORDER BY distance ASC LIMIT @cap`,
      )
      .all({ node: nodeId, project, cutoff, seed, k, cap }) as {
      id: string;
      distance: number;
    }[];
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

  // `same_session` and `youngest_created_at` carry the burst signature: who wrote the pair
  // and when. Provenance is what separates a real duplicate from a series; content
  // similarity does not.
  // One duplicate pair, built from a neighbour hit the sweep already found. Null when the
  // two are already related by `supersedes`, or when the pair is a candidate already —
  // both cheap, and both ahead of the four lookups the pair itself costs.
  duplicatePairFor(a: string, b: string, score: number): DuplicatePair | null {
    if (this.hasSupersedes(a, b)) return null;

    const [x, y] = a < b ? [a, b] : [b, a];

    if (this.candidateExists(ConsolidationKind.MERGE, [x, y])) return null;

    const { survivor } = this.chooseSurvivor(a, b);
    const project = (
      this.db.prepare("SELECT project FROM nodes WHERE id = ?").get(survivor) as {
        project: string | null;
      }
    ).project;
    const provenanceOf = this.db.prepare(
      "SELECT created_by_session AS session, created_at FROM nodes WHERE id = ?",
    );
    const px = provenanceOf.get(x) as Provenance;
    const py = provenanceOf.get(y) as Provenance;

    return {
      member_ids: [x, y],
      canonical_id: survivor,
      project,
      score,
      same_session: px.session === py.session,
      youngest_created_at: px.created_at > py.created_at ? px.created_at : py.created_at,
    };
  }

  // ---- detection: wikilinks -------------------------------------------------

  // Symbols that a citation may resolve to: name, the node it is, and the repo it came
  // from, so a note can be held to its own project's code.
  citableSymbols(): { name: string; node_id: string; repo: string }[] {
    return this.db
      .prepare(
        `SELECT sy.name AS name, sy.node_id AS node_id, sy.repo AS repo
         FROM symbols sy JOIN nodes n ON n.id = sy.node_id
         WHERE n.invalidated_at IS NULL`,
      )
      .all() as { name: string; node_id: string; repo: string }[];
  }

  // Every live authored node with its current body, which is both the text the citations
  // are read from and the titles the wikilinks resolve against.
  authoredBodies(): { id: string; title: string; project: string | null; content: string }[] {
    return this.db
      .prepare(
        `WITH current AS (
           SELECT r.node_id, r.content, r.rev,
                  ROW_NUMBER() OVER (PARTITION BY r.node_id ORDER BY r.rev DESC) AS seq
           FROM revisions r
         )
         SELECT n.id AS id, n.title AS title, n.project AS project, c.content AS content
         FROM current c
         JOIN nodes n ON n.id = c.node_id
         WHERE c.seq = 1
           AND n.invalidated_at IS NULL
           AND n.memory_kind IN ('semantic', 'episodic')`,
      )
      .all() as { id: string; title: string; project: string | null; content: string }[];
  }

  // Revisions are append-only, so this changes if and only if a body or a title arrived
  // since the last look — and only those can make a new wikilink resolvable.
  revisionCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM revisions").get() as { n: number }).n;
  }

  // Titles of retired authored nodes, so a wikilink naming one can be followed to
  // whatever superseded it. Titles only — the bodies are not read.
  retiredAuthoredTitles(): { id: string; title: string }[] {
    return this.db
      .prepare(
        `SELECT id, title FROM nodes
         WHERE invalidated_at IS NOT NULL AND memory_kind IN ('semantic', 'episodic')`,
      )
      .all() as { id: string; title: string }[];
  }

  // ---- detection: Tier-1 mirror prune ---------------------------------------

  // Advances on every code index run. `code_files` is only ever written by indexing, so
  // an unchanged watermark means no symbol can have been orphaned since the last look.
  codeIndexWatermark(): string | null {
    return (
      this.db.prepare("SELECT MAX(indexed_at) AS at FROM code_repos").get() as {
        at: string | null;
      }
    ).at;
  }

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
         ${LATEST_REVISION}
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

  // Resolve a still-pending candidate identified by what it is about rather than by id, for
  // when the sweep performs the same act the queued candidate was asking a person to
  // approve. Without this a posture switched from `suggest` to `auto` leaves its old queue
  // pending forever, since nothing will ever apply a row whose work is already done.
  resolvePendingByMembers(
    kind: ConsolidationKind,
    memberIds: string[],
    status: Exclude<ConsolidationStatus, "pending">,
    resolvedBy: string,
    ts: string,
  ): boolean {
    const info = this.tx(() =>
      this.db
        .prepare(
          `UPDATE consolidation_candidates SET status = ?, resolved_at = ?, resolved_by = ?
           WHERE member_hash = ? AND status = 'pending'`,
        )
        .run(status, ts, resolvedBy, candidateHash(kind, memberIds)),
    );

    return info.changes > 0;
  }

  resolveCandidateAtomically(
    id: string,
    resolvedBy: string,
    ts: string,
    operation: (
      candidate: ConsolidationCandidate,
    ) => Exclude<ConsolidationStatus, ConsolidationStatus.PENDING>,
  ): {
    candidate: ConsolidationCandidate;
    status: Exclude<ConsolidationStatus, ConsolidationStatus.PENDING>;
  } | null {
    return this.tx(() => {
      const candidate = this.getCandidate(id);
      if (candidate?.status !== ConsolidationStatus.PENDING) return null;

      const status = operation(candidate);
      const info = this.db
        .prepare(
          `UPDATE consolidation_candidates SET status = ?, resolved_at = ?, resolved_by = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(status, ts, resolvedBy, id);
      if (info.changes !== 1) throw new Error(`failed to resolve pending candidate ${id}`);

      return { candidate, status };
    });
  }
  reportTick(runId: string, result: ConsolidationTickResult): void {
    this.db
      .prepare(
        `INSERT INTO consolidation_runs (
          id, started_at, updated_at, ended_at, stage,
          links_added, links_suggested, links_pruned, wikilinks_linked, wikilinks_dangling,
          documents_linked, documents_suggested,
          distilled, distill_suggested, merged, merge_suggested, merge_delayed,
          pruned, prune_suggested, proposals_backfilled, rejected, annotated,
          generation_failures, last_error, stage_ms
        ) VALUES (
          @id, @started_at, @updated_at, @ended_at, @stage,
          @links_added, @links_suggested, @links_pruned, @wikilinks_linked, @wikilinks_dangling,
          @documents_linked, @documents_suggested,
          @distilled, @distill_suggested, @merged, @merge_suggested, @merge_delayed,
          @pruned, @prune_suggested, @proposals_backfilled, @rejected, @annotated,
          @generation_failures, @last_error, @stage_ms
        )
        ON CONFLICT(id) DO UPDATE SET
          updated_at = excluded.updated_at,
          ended_at = excluded.ended_at,
          stage = excluded.stage,
          links_added = excluded.links_added,
          links_suggested = excluded.links_suggested,
          links_pruned = excluded.links_pruned,
          wikilinks_linked = excluded.wikilinks_linked,
          wikilinks_dangling = excluded.wikilinks_dangling,
          documents_linked = excluded.documents_linked,
          documents_suggested = excluded.documents_suggested,
          distilled = excluded.distilled,
          distill_suggested = excluded.distill_suggested,
          merged = excluded.merged,
          merge_suggested = excluded.merge_suggested,
          merge_delayed = excluded.merge_delayed,
          pruned = excluded.pruned,
          prune_suggested = excluded.prune_suggested,
          proposals_backfilled = excluded.proposals_backfilled,
          rejected = excluded.rejected,
          annotated = excluded.annotated,
          generation_failures = excluded.generation_failures,
          last_error = excluded.last_error,
          stage_ms = excluded.stage_ms
        `,
      )
      .run({
        id: runId,
        started_at: result.started_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ended_at: result.ended_at || null,
        stage: result.stage || "unknown",
        stage_ms: result.stage_ms ? JSON.stringify(result.stage_ms) : null,
        links_added: result.links_added,
        links_suggested: result.links_suggested,
        links_pruned: result.links_pruned,
        wikilinks_linked: result.wikilinks_linked,
        wikilinks_dangling: result.wikilinks_dangling,
        documents_linked: result.documents_linked,
        documents_suggested: result.documents_suggested,
        distilled: result.distilled,
        distill_suggested: result.distill_suggested,
        merged: result.merged,
        merge_suggested: result.merge_suggested,
        merge_delayed: result.merge_delayed,
        pruned: result.pruned,
        prune_suggested: result.prune_suggested,
        proposals_backfilled: result.proposals_backfilled,
        rejected: result.rejected,
        annotated: result.annotated,
        generation_failures: result.generation_failures,
        last_error: result.last_error,
      });
  }

  clearCandidateProposal(id: string, error: string | null): void {
    this.db
      .prepare("UPDATE consolidation_candidates SET proposal = NULL, last_error = ? WHERE id = ?")
      .run(error, id);
  }

  reopenCandidate(id: string): void {
    this.db
      .prepare(
        "UPDATE consolidation_candidates SET status = 'pending', attempts = attempts + 1 WHERE id = ?",
      )
      .run(id);
  }
}
