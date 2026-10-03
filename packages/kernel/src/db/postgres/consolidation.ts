import { injectable } from "tsyringe";
import type { ConsolidationRunSummary } from "@cerebrium/contracts/dashboard";
import type {
  ConsolidationCandidate,
  ConsolidationProposal,
  NewCandidate,
} from "@cerebrium/contracts/types";
import {
  ConsolidationKind,
  ConsolidationStatus,
  MemoryKind,
  type EdgeType,
} from "@cerebrium/contracts/vocab";
import type { ConsolidationTickResult } from "@/domain/ports/consolidation-reporter";
import {
  candidateHash,
  pairKey,
  type ConsolidationRepo,
  type DuplicatePair,
  type EdgelessNode,
  type RelationInput,
  type ResolvedStatus,
  type StrandedEdge,
  type SweepSeed,
  type UntypedLink,
} from "@/domain/ports/storage";
import { RUN_SUMMARY_COLUMNS, runSummaryOf, type RunSummaryRow } from "@/db/activity-rows";
import { PgBaseRepo } from "@/db/postgres/base";
import { ACTIVE_SPACE, LATEST_REVISION, sameProjectFamily } from "@/db/postgres/internal";
import { newId } from "@/core/ids";

const CANDIDATE_COLS =
  "id, kind, status, project, member_ids, canonical_id, score, proposal, detected_at, resolved_at, resolved_by, attempts, last_error";

const PENDING_ORDER = "ORDER BY score DESC, detected_at ASC, id ASC";

// A node has an embedding when one of its live chunks has a vector in the active space.
const EMBEDDED = `EXISTS (
  SELECT 1 FROM chunks c JOIN chunk_vectors v ON v.chunk_id = c.id AND v.space_id = ${ACTIVE_SPACE}
  WHERE c.node_id = n.id AND c.stale = 0
)`;

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

// See db/sqlite/consolidation.ts for what each query is for. On this backend there is no
// code mirror, so the symbol-backed inputs (citations, the prune watermark, dead mirrors)
// are empty rather than absent.
@injectable()
export class PgConsolidationRepo extends PgBaseRepo implements ConsolidationRepo {
  async insertCandidate(input: NewCandidate): Promise<string | null> {
    const id = newId();
    const inserted = await this.run(
      `INSERT INTO consolidation_candidates
         (id, kind, status, project, member_ids, member_hash, canonical_id, score, proposal, detected_at)
       VALUES (@id, @kind, 'pending', @project, @member_ids, @member_hash, @canonical_id, @score, @proposal, @detected_at)
       ON CONFLICT (member_hash) DO NOTHING`,
      {
        id,
        kind: input.kind,
        project: input.project ?? null,
        member_ids: JSON.stringify(input.member_ids),
        member_hash: candidateHash(input.kind, input.member_ids),
        canonical_id: input.canonical_id ?? null,
        score: input.score,
        proposal: input.proposal != null ? JSON.stringify(input.proposal) : null,
        detected_at: input.detected_at,
      },
    );

    return inserted > 0 ? id : null;
  }

  async candidateExists(kind: ConsolidationKind, memberIds: string[]): Promise<boolean> {
    return (
      (await this.one("SELECT 1 FROM consolidation_candidates WHERE member_hash = @hash", {
        hash: candidateHash(kind, memberIds),
      })) !== undefined
    );
  }

  async pendingNeedingProposal(limit: number): Promise<ConsolidationCandidate[]> {
    return (
      await this.all<CandidateRow>(
        `SELECT ${CANDIDATE_COLS} FROM consolidation_candidates
         WHERE status = 'pending' AND kind IN ('distill','merge')
           AND (proposal IS NULL OR proposal::jsonb -> 'recommendation' IS NULL
                OR proposal::jsonb -> 'recommendation' = 'null'::jsonb)
         ORDER BY score DESC, detected_at ASC, id ASC LIMIT @limit`,
        { limit },
      )
    ).map(toCandidate);
  }

  async setCandidateProposal(id: string, proposal: ConsolidationProposal): Promise<boolean> {
    return (
      (await this.run(
        "UPDATE consolidation_candidates SET proposal = @proposal WHERE id = @id AND status = 'pending'",
        { proposal: JSON.stringify(proposal), id },
      )) > 0
    );
  }

  async getCandidate(id: string): Promise<ConsolidationCandidate | undefined> {
    const r = await this.one<CandidateRow>(
      `SELECT ${CANDIDATE_COLS} FROM consolidation_candidates WHERE id = @id`,
      { id },
    );

    return r ? toCandidate(r) : undefined;
  }

  async pendingCandidateCount(): Promise<number> {
    return (
      (
        await this.one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM consolidation_candidates WHERE status = 'pending'",
        )
      )?.n ?? 0
    );
  }

  async pendingCandidates(opts?: {
    kind?: ConsolidationKind;
    limit?: number;
  }): Promise<ConsolidationCandidate[]> {
    const params = { limit: opts?.limit ?? 50, kind: opts?.kind ?? null };

    return (
      await this.all<CandidateRow>(
        `SELECT ${CANDIDATE_COLS} FROM consolidation_candidates
         WHERE status = 'pending' AND (@kind::text IS NULL OR kind = @kind)
         ${PENDING_ORDER} LIMIT @limit`,
        params,
      )
    ).map(toCandidate);
  }

  async pendingCandidatePage(opts: {
    kind?: ConsolidationKind;
    limit: number;
    after?: { score: number; detected_at: string; id: string };
  }): Promise<ConsolidationCandidate[]> {
    const where = ["status = 'pending'"];
    const params: Record<string, unknown> = { limit: opts.limit };

    if (opts.kind !== undefined) {
      where.push("kind = @kind");
      params.kind = opts.kind;
    }

    if (opts.after !== undefined) {
      where.push(
        `(score < @score
          OR (score = @score AND detected_at > @detected_at)
          OR (score = @score AND detected_at = @detected_at AND id > @after_id))`,
      );
      params.score = opts.after.score;
      params.detected_at = opts.after.detected_at;
      params.after_id = opts.after.id;
    }

    return (
      await this.all<CandidateRow>(
        `SELECT ${CANDIDATE_COLS} FROM consolidation_candidates
         WHERE ${where.join(" AND ")} ${PENDING_ORDER} LIMIT @limit`,
        params,
      )
    ).map(toCandidate);
  }

  private async linkableNodes(limit: number): Promise<string[]> {
    return (
      await this.all<{ id: string }>(
        `SELECT n.id AS id FROM nodes n
         WHERE n.memory_kind = 'semantic' AND n.invalidated_at IS NULL AND ${EMBEDDED}
         ORDER BY n.id DESC LIMIT @limit`,
        { limit },
      )
    ).map((r) => r.id);
  }

  private async orphanEpisodics(limit: number): Promise<string[]> {
    return (
      await this.all<{ id: string }>(
        `SELECT n.id AS id FROM nodes n
         WHERE n.memory_kind = 'episodic' AND n.invalidated_at IS NULL AND ${EMBEDDED}
           AND NOT EXISTS (
             SELECT 1 FROM edges e
             WHERE e.invalidated_at IS NULL AND (e.src = n.id OR e.dst = n.id)
           )
         ORDER BY n.id DESC LIMIT @limit`,
        { limit },
      )
    ).map((r) => r.id);
  }

  // The kNN seed: a node's lowest-seq chunk vector in the active space, as pgvector text.
  private async seedVector(nodeId: string): Promise<string | null> {
    return (
      (
        await this.one<{ embedding: string }>(
          `SELECT v.embedding::text AS embedding FROM chunks c
           JOIN chunk_vectors v ON v.chunk_id = c.id AND v.space_id = ${ACTIVE_SPACE}
           WHERE c.node_id = @nodeId AND c.stale = 0 ORDER BY c.seq LIMIT 1`,
          { nodeId },
        )
      )?.embedding ?? null
    );
  }

  private knn(filter: string): string {
    return `WITH knn AS (
         SELECT v.chunk_id, v.embedding <=> @seed::vector AS distance
         FROM chunk_vectors v
         WHERE v.space_id = ${ACTIVE_SPACE}
         ORDER BY distance, v.chunk_id
         LIMIT @k
       )
       SELECT n.id AS id, MIN(knn.distance) AS distance
       FROM knn
       JOIN chunks c ON c.id = knn.chunk_id
       JOIN nodes n ON n.id = c.node_id
       WHERE n.id <> @node AND ${filter}
       GROUP BY n.id ORDER BY distance ASC, n.id LIMIT @cap`;
  }

  private async nearestSemantic(
    nodeId: string,
    k: number,
    cap: number,
  ): Promise<{ id: string; distance: number }[]> {
    const seed = await this.seedVector(nodeId);

    if (!seed) return [];

    return this.all(
      this.knn(
        `n.memory_kind = 'semantic' AND n.invalidated_at IS NULL
         AND ${sameProjectFamily("n.project", "(SELECT project FROM nodes WHERE id = @node)")}`,
      ),
      { node: nodeId, seed, k, cap },
    );
  }

  async sweepSeeds(limit: number): Promise<SweepSeed[]> {
    return [
      ...(await this.linkableNodes(limit)).map((id, ordinal) => ({
        id,
        kind: MemoryKind.SEMANTIC,
        ordinal,
      })),
      ...(await this.orphanEpisodics(limit)).map((id, ordinal) => ({
        id,
        kind: MemoryKind.EPISODIC,
        ordinal,
      })),
    ];
  }

  async neighboursOf(
    seedId: string,
    opts: { minScore: number; k?: number; capPerNode?: number },
  ): Promise<{ id: string; score: number }[]> {
    return (await this.nearestSemantic(seedId, opts.k ?? 20, opts.capPerNode ?? 10))
      .map((nb) => ({ id: nb.id, score: 1 - nb.distance }))
      .filter((nb) => nb.score >= opts.minScore);
  }

  async storedSimilarPairs(): Promise<Set<string>> {
    return new Set(
      (
        await this.all<{ src: string; dst: string }>(
          "SELECT src, dst FROM edges WHERE type = 'similar_to'",
        )
      ).map((e) => pairKey(e.src, e.dst)),
    );
  }

  async linkDegrees(ids: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>(ids.map((id) => [id, 0]));

    if (!ids.length) return out;

    const rows = await this.all<{ id: string; degree: number }>(
      `SELECT id, COUNT(*) AS degree FROM (
         SELECT e.src AS id FROM edges e
         JOIN nodes d ON d.id = e.dst AND d.memory_kind <> 'mirror' AND d.invalidated_at IS NULL
         WHERE e.type = 'similar_to' AND e.invalidated_at IS NULL AND e.src = ANY(@ids)
         UNION ALL
         SELECT e.dst AS id FROM edges e
         JOIN nodes s ON s.id = e.src AND s.memory_kind <> 'mirror' AND s.invalidated_at IS NULL
         WHERE e.type = 'similar_to' AND e.invalidated_at IS NULL AND e.dst = ANY(@ids)
       ) incident GROUP BY id`,
      { ids },
    );

    for (const r of rows) out.set(r.id, r.degree);

    return out;
  }

  async overCapSimilarLinks(opts: {
    maxDegree: number;
    limit: number;
  }): Promise<{ src: string; dst: string }[]> {
    return this.all(
      `WITH live AS (
         SELECT id FROM nodes WHERE memory_kind <> 'mirror' AND invalidated_at IS NULL
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
       SELECT se.src AS src, se.dst AS dst
       FROM se
       JOIN rk ON (rk.node = se.src AND rk.other = se.dst)
               OR (rk.node = se.dst AND rk.other = se.src)
       GROUP BY se.src, se.dst
       HAVING MIN(rk.r) > @maxDegree
       ORDER BY MIN(rk.r) DESC, se.src, se.dst LIMIT @limit`,
      { maxDegree: opts.maxDegree, limit: opts.limit },
    );
  }

  async edgelessNodes(limit: number): Promise<EdgelessNode[]> {
    return this.all(
      `SELECT n.id AS id, n.memory_kind AS kind, n.project AS project FROM nodes n
       WHERE n.memory_kind IN ('semantic', 'episodic') AND n.invalidated_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM edges e JOIN nodes o ON o.id = e.dst
           WHERE e.src = n.id AND e.dst <> n.id AND e.invalidated_at IS NULL
             AND o.memory_kind IN ('semantic', 'episodic') AND o.invalidated_at IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM edges e JOIN nodes o ON o.id = e.src
           WHERE e.dst = n.id AND e.src <> n.id AND e.invalidated_at IS NULL
             AND o.memory_kind IN ('semantic', 'episodic') AND o.invalidated_at IS NULL
         )
       ORDER BY n.id LIMIT @limit`,
      { limit },
    );
  }

  async anchorCheckpoint(id: string): Promise<string | null> {
    return (
      (
        await this.one<{ id: string }>(
          `SELECT c.id AS id FROM nodes n
           JOIN nodes c ON c.memory_kind = 'episodic' AND c.type = 'checkpoint'
             AND c.invalidated_at IS NULL AND c.id <> n.id
             AND ((c.created_by_session = n.created_by_session
                   AND ${sameProjectFamily("c.project", "n.project")})
                  OR (c.project IS NOT DISTINCT FROM n.project AND c.created_at <= n.created_at))
           WHERE n.id = @id
           ORDER BY CASE WHEN c.created_by_session = n.created_by_session THEN 0 ELSE 1 END,
                    c.created_at DESC, c.id DESC
           LIMIT 1`,
          { id },
        )
      )?.id ?? null
    );
  }

  async untypedLinks(limit: number): Promise<UntypedLink[]> {
    return this.all(
      `WITH live AS (
         SELECT id FROM nodes
         WHERE memory_kind IN ('semantic', 'episodic') AND invalidated_at IS NULL
       )
       SELECT e.src AS src, e.dst AS dst, e.weight AS weight,
              EXISTS (
                SELECT 1 FROM edges o
                WHERE o.invalidated_at IS NULL AND o.type <> 'similar_to'
                  AND ((o.src = e.src AND o.dst = e.dst) OR (o.src = e.dst AND o.dst = e.src))
              ) AS connected
       FROM edges e JOIN live s ON s.id = e.src JOIN live d ON d.id = e.dst
       WHERE e.type = 'similar_to' AND e.invalidated_at IS NULL
       ORDER BY e.weight DESC, e.src, e.dst LIMIT @limit`,
      { limit },
    );
  }

  async relationInputs(ids: string[]): Promise<RelationInput[]> {
    if (!ids.length) return [];

    const rows = await this.all<RelationInput>(
      `SELECT n.id AS id, n.title AS title, n.type AS type, n.project AS project,
              n.created_at AS created_at, lr.content AS content
       FROM nodes n ${LATEST_REVISION} WHERE n.id = ANY(@ids)`,
      { ids },
    );
    const byId = new Map(rows.map((r) => [r.id, r]));

    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  async strandedSystemEdges(limit: number): Promise<StrandedEdge[]> {
    return this.all(
      `SELECT e.src AS src, e.dst AS dst, e.type AS type, e.weight AS weight FROM edges e
       JOIN nodes s ON s.id = e.src
       JOIN nodes d ON d.id = e.dst
       WHERE e.invalidated_at IS NULL AND e.provenance = 'system'
         AND e.type NOT IN ('supersedes', 'similar_to')
         AND s.memory_kind IN ('semantic', 'episodic') AND s.invalidated_at IS NULL
         AND d.memory_kind IN ('semantic', 'episodic') AND d.invalidated_at IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM edges x WHERE x.dst = d.id AND x.type = 'supersedes'
             AND x.invalidated_at IS NULL
         )
       ORDER BY e.src, e.dst, e.type LIMIT @limit`,
      { limit },
    );
  }

  async revisedLinks(limit: number): Promise<StrandedEdge[]> {
    return this.all(
      `SELECT e.src AS src, e.dst AS dst, e.type AS type, e.weight AS weight FROM edges e
       JOIN nodes s ON s.id = e.src
       JOIN nodes d ON d.id = e.dst
       LEFT JOIN edge_checks c ON c.src = e.src AND c.dst = e.dst AND c.type = e.type
       WHERE e.invalidated_at IS NULL AND e.provenance = 'system'
         AND e.type IN ('relates_to', 'references')
         AND s.memory_kind IN ('semantic', 'episodic') AND s.invalidated_at IS NULL
         AND d.memory_kind IN ('semantic', 'episodic') AND d.invalidated_at IS NULL
         AND EXISTS (
           SELECT 1 FROM revisions r
           WHERE r.node_id IN (e.src, e.dst) AND r.rev > 1
             AND r.ts > COALESCE(c.checked_at, e.valid_from)
         )
       ORDER BY e.src, e.dst, e.type LIMIT @limit`,
      { limit },
    );
  }

  async markLinkChecked(src: string, dst: string, type: EdgeType, ts: string): Promise<void> {
    await this.run(
      `INSERT INTO edge_checks (src, dst, type, checked_at) VALUES (@src, @dst, @type, @ts)
       ON CONFLICT (src, dst, type) DO UPDATE SET checked_at = excluded.checked_at`,
      { src, dst, type, ts },
    );
  }

  async crossProjectSystemLinks(limit: number): Promise<StrandedEdge[]> {
    return this.all(
      `SELECT e.src AS src, e.dst AS dst, e.type AS type, e.weight AS weight FROM edges e
       JOIN nodes s ON s.id = e.src
       JOIN nodes d ON d.id = e.dst
       WHERE e.invalidated_at IS NULL AND e.provenance = 'system'
         AND e.type IN ('similar_to', 'relates_to')
         AND s.memory_kind IN ('semantic', 'episodic') AND s.invalidated_at IS NULL
         AND d.memory_kind IN ('semantic', 'episodic') AND d.invalidated_at IS NULL
         AND NOT ${sameProjectFamily("s.project", "d.project")}
       ORDER BY e.src, e.dst, e.type LIMIT @limit`,
      { limit },
    );
  }

  async candidateInputs(ids: string[]): Promise<{ id: string; title: string; content: string }[]> {
    if (!ids.length) return [];

    const rows = await this.all<{ id: string; title: string; content: string }>(
      `SELECT n.id AS id, n.title AS title,
              (SELECT content FROM revisions WHERE node_id = n.id ORDER BY rev DESC LIMIT 1) AS content
       FROM nodes n WHERE n.id = ANY(@ids)`,
      { ids },
    );
    const byId = new Map(rows.map((r) => [r.id, r]));

    return ids.flatMap((id) => {
      const r = byId.get(id);

      return r ? [r] : [];
    });
  }

  private async eligibleEpisodics(
    cutoff: string,
    limit: number,
  ): Promise<{ id: string; project: string | null }[]> {
    return this.all(
      `SELECT n.id AS id, n.project AS project FROM nodes n
       WHERE n.memory_kind = 'episodic' AND n.invalidated_at IS NULL
         AND n.consolidated_at IS NULL AND n.valid_from <= @cutoff AND ${EMBEDDED}
       ORDER BY n.id LIMIT @limit`,
      { cutoff, limit },
    );
  }

  private async nearestEpisodic(
    nodeId: string,
    project: string | null,
    cutoff: string,
    k: number,
    cap: number,
  ): Promise<{ id: string; distance: number }[]> {
    const seed = await this.seedVector(nodeId);

    if (!seed) return [];

    return this.all(
      this.knn(
        `n.memory_kind = 'episodic' AND n.invalidated_at IS NULL
         AND n.consolidated_at IS NULL AND n.valid_from <= @cutoff
         AND n.project IS NOT DISTINCT FROM @project::text`,
      ),
      { node: nodeId, project, cutoff, seed, k, cap },
    );
  }

  async staleEpisodicClusters(opts: {
    minScore: number;
    minCluster: number;
    cutoff: string;
    limit: number;
    k?: number;
    capPerNode?: number;
  }): Promise<{ project: string | null; member_ids: string[]; score: number }[]> {
    const k = opts.k ?? 20;
    const cap = opts.capPerNode ?? 10;
    const eligible = await this.eligibleEpisodics(opts.cutoff, opts.limit);
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
      for (const nb of await this.nearestEpisodic(e.id, e.project, opts.cutoff, k, cap)) {
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

  private async hasSupersedes(a: string, b: string): Promise<boolean> {
    return (
      (await this.one(
        `SELECT 1 FROM edges WHERE type = 'supersedes'
         AND ((src = @a AND dst = @b) OR (src = @b AND dst = @a)) LIMIT 1`,
        { a, b },
      )) !== undefined
    );
  }

  private async chooseSurvivor(a: string, b: string): Promise<{ survivor: string; loser: string }> {
    const rank = (id: string) =>
      this.one<{ edges: number; valid_from: string }>(
        `SELECT (SELECT COUNT(*) FROM edges e WHERE (e.src = n.id OR e.dst = n.id) AND e.invalidated_at IS NULL) AS edges,
                n.valid_from AS valid_from
         FROM nodes n WHERE n.id = @id`,
        { id },
      );
    const ra = (await rank(a))!;
    const rb = (await rank(b))!;
    let survivor: string;

    if (rb.edges !== ra.edges) survivor = rb.edges > ra.edges ? b : a;
    else if (rb.valid_from !== ra.valid_from) survivor = rb.valid_from > ra.valid_from ? b : a;
    else survivor = a < b ? a : b;

    return { survivor, loser: survivor === a ? b : a };
  }

  async duplicatePairFor(a: string, b: string, score: number): Promise<DuplicatePair | null> {
    if (await this.hasSupersedes(a, b)) return null;

    const [x, y] = a < b ? [a, b] : [b, a];

    if (await this.candidateExists(ConsolidationKind.MERGE, [x, y])) return null;

    const { survivor } = await this.chooseSurvivor(a, b);
    const project =
      (
        await this.one<{ project: string | null }>("SELECT project FROM nodes WHERE id = @id", {
          id: survivor,
        })
      )?.project ?? null;
    const provenanceOf = async (id: string) =>
      (await this.one<Provenance>(
        "SELECT created_by_session AS session, created_at FROM nodes WHERE id = @id",
        { id },
      ))!;
    const px = await provenanceOf(x);
    const py = await provenanceOf(y);

    return {
      member_ids: [x, y],
      canonical_id: survivor,
      project,
      score,
      same_session: px.session === py.session,
      youngest_created_at: px.created_at > py.created_at ? px.created_at : py.created_at,
    };
  }

  async citableSymbols(): Promise<{ name: string; node_id: string; repo: string }[]> {
    return [];
  }

  async authoredBodies(): Promise<
    { id: string; kind: MemoryKind; title: string; project: string | null; content: string }[]
  > {
    return this.all(
      `SELECT n.id AS id, n.memory_kind AS kind, n.title AS title, n.project AS project,
              lr.content AS content
       FROM nodes n
       ${LATEST_REVISION}
       WHERE n.invalidated_at IS NULL AND n.memory_kind IN ('semantic', 'episodic')
       ORDER BY n.id`,
    );
  }

  async revisionCount(): Promise<number> {
    return (await this.one<{ n: number }>("SELECT COUNT(*) AS n FROM revisions"))?.n ?? 0;
  }

  async retiredAuthoredTitles(): Promise<{ id: string; title: string }[]> {
    return this.all(
      `SELECT id, title FROM nodes
       WHERE invalidated_at IS NOT NULL AND memory_kind IN ('semantic', 'episodic')
       ORDER BY id`,
    );
  }

  async formerTitles(): Promise<{ id: string; title: string }[]> {
    return this.all(
      `SELECT t.node_id AS id, t.title AS title FROM node_titles t
       JOIN nodes n ON n.id = t.node_id
       WHERE n.invalidated_at IS NULL AND n.memory_kind IN ('semantic', 'episodic')
         AND t.title <> n.title
       ORDER BY t.node_id, t.title`,
    );
  }

  async ignoredWikilinks(): Promise<{ node_id: string; link: string }[]> {
    return this.all("SELECT node_id, link FROM wikilink_ignores ORDER BY node_id, link");
  }

  async ignoreWikilink(nodeId: string, link: string, ts: string): Promise<void> {
    await this.run(
      `INSERT INTO wikilink_ignores (node_id, link, ignored_at) VALUES (@nodeId, @link, @ts)
       ON CONFLICT DO NOTHING`,
      { nodeId, link, ts },
    );
  }

  async codeIndexWatermark(): Promise<string | null> {
    return null;
  }

  async deadMirrorNodes(): Promise<string[]> {
    return [];
  }

  async unannotatedSemantic(
    limit: number,
  ): Promise<
    { id: string; rev: number; title: string; content: string; project: string | null }[]
  > {
    return this.all(
      `SELECT n.id AS id, lr.rev AS rev, n.title AS title, lr.content AS content, n.project AS project
       FROM nodes n
       ${LATEST_REVISION}
       LEFT JOIN revision_annotations ra ON ra.node_id = n.id AND ra.rev = lr.rev
       WHERE n.memory_kind = 'semantic' AND n.invalidated_at IS NULL AND ra.node_id IS NULL
       ORDER BY n.valid_from DESC, n.id DESC LIMIT @limit`,
      { limit },
    );
  }

  async resolveCandidate(
    id: string,
    status: Exclude<ConsolidationStatus, "pending">,
    resolvedBy: string,
    ts: string,
  ): Promise<boolean> {
    return (
      (await this.run(
        `UPDATE consolidation_candidates SET status = @status, resolved_at = @ts, resolved_by = @resolvedBy
         WHERE id = @id AND status = 'pending'`,
        { status, ts, resolvedBy, id },
      )) > 0
    );
  }

  async resolvePendingByMembers(
    kind: ConsolidationKind,
    memberIds: string[],
    status: Exclude<ConsolidationStatus, "pending">,
    resolvedBy: string,
    ts: string,
  ): Promise<boolean> {
    return (
      (await this.run(
        `UPDATE consolidation_candidates SET status = @status, resolved_at = @ts, resolved_by = @resolvedBy
         WHERE member_hash = @hash AND status = 'pending'`,
        { status, ts, resolvedBy, hash: candidateHash(kind, memberIds) },
      )) > 0
    );
  }

  async dismissRetiredCandidates(resolvedBy: string, ts: string): Promise<number> {
    return this.run(
      `UPDATE consolidation_candidates c
       SET status = 'dismissed', resolved_at = @ts, resolved_by = @resolvedBy
       WHERE c.status = 'pending'
         AND EXISTS (
           SELECT 1 FROM nodes n
           WHERE n.id IN (SELECT jsonb_array_elements_text(c.member_ids::jsonb))
             AND n.invalidated_at IS NOT NULL)`,
      { ts, resolvedBy },
    );
  }

  // One transaction: the writes `operation` makes through other repositories nest inside
  // it as savepoints, so they commit or roll back with the resolution.
  async resolveCandidateAtomically(
    id: string,
    resolvedBy: string,
    ts: string,
    operation: (candidate: ConsolidationCandidate) => Promise<ResolvedStatus>,
  ): Promise<{ candidate: ConsolidationCandidate; status: ResolvedStatus } | null> {
    return this.tx(async () => {
      const row = await this.one<CandidateRow>(
        `SELECT ${CANDIDATE_COLS} FROM consolidation_candidates WHERE id = @id FOR UPDATE`,
        { id },
      );
      const candidate = row ? toCandidate(row) : undefined;

      if (candidate?.status !== ConsolidationStatus.PENDING) return null;

      const status = await operation(candidate);
      const changed =
        (
          await this.db.query(
            `UPDATE consolidation_candidates SET status = @status, resolved_at = @ts, resolved_by = @resolvedBy
             WHERE id = @id AND status = 'pending'`,
            { status, ts, resolvedBy, id },
          )
        ).rowCount ?? 0;

      if (changed !== 1) throw new Error(`failed to resolve pending candidate ${id}`);

      return { candidate, status };
    });
  }

  async recentRuns(limit: number): Promise<ConsolidationRunSummary[]> {
    return (
      await this.all<RunSummaryRow>(
        `SELECT ${RUN_SUMMARY_COLUMNS} FROM consolidation_runs
         ORDER BY started_at DESC, id DESC LIMIT @limit`,
        { limit },
      )
    ).map(runSummaryOf);
  }

  async reportTick(runId: string, result: ConsolidationTickResult): Promise<void> {
    await this.run(
      `INSERT INTO consolidation_runs (
        id, started_at, updated_at, ended_at, stage,
        links_added, links_suggested, links_pruned, wikilinks_linked, wikilinks_dangling,
        documents_linked, documents_suggested,
        distilled, distill_suggested, merged, merge_suggested, merge_delayed,
        pruned, prune_suggested, proposals_backfilled, rejected, annotated,
        generation_failures, last_error, stage_ms, integrity
      ) VALUES (
        @id, @started_at, @updated_at, @ended_at, @stage,
        @links_added, @links_suggested, @links_pruned, @wikilinks_linked, @wikilinks_dangling,
        @documents_linked, @documents_suggested,
        @distilled, @distill_suggested, @merged, @merge_suggested, @merge_delayed,
        @pruned, @prune_suggested, @proposals_backfilled, @rejected, @annotated,
        @generation_failures, @last_error, @stage_ms, @integrity
      )
      ON CONFLICT (id) DO UPDATE SET
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
        stage_ms = excluded.stage_ms,
        integrity = excluded.integrity
      WHERE consolidation_runs.ended_at IS NULL`,
      {
        id: runId,
        started_at: result.started_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ended_at: result.ended_at || null,
        stage: result.stage || "unknown",
        stage_ms: result.stage_ms ? JSON.stringify(result.stage_ms) : null,
        integrity: result.integrity ? JSON.stringify(result.integrity) : null,
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
      },
    );
  }

  async closeRun(runId: string, at: string, reason: string): Promise<void> {
    await this.run(
      `UPDATE consolidation_runs
          SET ended_at = @at, updated_at = @at, stage = 'interrupted',
              last_error = COALESCE(last_error, @reason)
        WHERE id = @runId AND ended_at IS NULL`,
      { at, reason, runId },
    );
  }

  async closeAbandonedRuns(reason: string): Promise<number> {
    return this.run(
      `UPDATE consolidation_runs
          SET ended_at = updated_at, stage = 'interrupted',
              last_error = COALESCE(last_error, @reason)
        WHERE ended_at IS NULL`,
      { reason },
    );
  }

  async clearCandidateProposal(id: string, error: string | null): Promise<void> {
    await this.run(
      "UPDATE consolidation_candidates SET proposal = NULL, last_error = @error WHERE id = @id",
      { error, id },
    );
  }

  async reopenCandidate(id: string): Promise<void> {
    await this.run(
      "UPDATE consolidation_candidates SET status = 'pending', attempts = attempts + 1 WHERE id = @id",
      { id },
    );
  }
}
