import { injectable } from "tsyringe";
import { BaseRepo } from "@/db/repositories/base";
import { ENRICHED, enrichedByIds } from "@/db/repositories/internal";
import type { EnrichedRow, Envelope, SearchRow, VectorRow } from "@/core/types";
import { toEnvelope } from "@/core/types";

// KNN over-fetch: pull this many nearest chunks, then filter + collapse to the
// best chunk per node. Generous for a personal-scale store; raise if a project
// ever holds enough chunks that post-filter starves the candidate set.
const VEC_K = 200;

// Read-side retrieval: full-text (bm25), vector KNN, and the session working-set
// queries. Read-only — no transactions.
@injectable()
export class SearchRepo extends BaseRepo {
  vectorSearch(
    embedding: number[],
    opts: {
      project?: string;
      kinds?: string[];
      types?: string[];
      history: boolean;
      cap: number;
      asOf?: string;
    },
  ): VectorRow[] {
    const where: string[] = ["c.stale = 0"];
    const params: Record<string, unknown> = { q: JSON.stringify(embedding), k: VEC_K };
    if (opts.project !== undefined) {
      where.push("n.project = @project");
      params.project = opts.project;
    }
    if (opts.kinds?.length) {
      where.push(`n.memory_kind IN (${opts.kinds.map((_, i) => `@k${i}`).join(",")})`);
      opts.kinds.forEach((k, i) => (params[`k${i}`] = k));
    }
    if (opts.types?.length) {
      where.push(`n.type IN (${opts.types.map((_, i) => `@t${i}`).join(",")})`);
      opts.types.forEach((t, i) => (params[`t${i}`] = t));
    }
    // `as_of` carries its own liveness rule — a node that was valid then belongs in the
    // answer even if it has since been invalidated — so it replaces the history flag.
    if (opts.asOf !== undefined) {
      where.push(
        "n.created_at <= @asOf AND (n.invalidated_at IS NULL OR n.invalidated_at > @asOf)",
      );
      params.asOf = opts.asOf;
    } else if (!opts.history) {
      where.push("n.invalidated_at IS NULL");
    }

    const rows = this.db
      .prepare(
        `WITH knn AS (SELECT chunk_id, distance FROM chunk_vec WHERE embedding MATCH @q AND k = @k)
         SELECT n.id, n.memory_kind, n.type, n.title, n.project, n.valid_from, n.invalidated_at,
                lr.rev AS rev, lr.ts AS updated, lr.content AS content,
                (SELECT COUNT(*) FROM edges e WHERE (e.src = n.id OR e.dst = n.id) AND e.invalidated_at IS NULL) AS edge_count,
                n.use_count, n.last_used_at,
                knn.distance AS distance, c.text AS chunk_text
         FROM knn
         JOIN chunks c ON c.id = knn.chunk_id
         JOIN nodes n ON n.id = c.node_id
         JOIN (SELECT node_id, MAX(rev) AS mrev FROM revisions GROUP BY node_id) m ON m.node_id = n.id
         JOIN revisions lr ON lr.node_id = n.id AND lr.rev = m.mrev
         WHERE ${where.join(" AND ")}
         ORDER BY knn.distance ASC`,
      )
      .all(params) as VectorRow[];

    const seen = new Set<string>();
    const best: VectorRow[] = [];
    for (const r of rows) {
      if (seen.has(r.id)) continue; // best (nearest) chunk per node wins
      seen.add(r.id);
      best.push(r);
      if (best.length >= opts.cap) break;
    }
    return best;
  }

  search(opts: {
    match: string;
    project?: string;
    kinds?: string[];
    types?: string[];
    history: boolean;
    cap: number;
    asOf?: string;
  }): { rows: SearchRow[]; total: number } {
    const where: string[] = ["node_fts MATCH @match"];
    const params: Record<string, unknown> = { match: opts.match };
    if (opts.project !== undefined) {
      where.push("n.project = @project");
      params.project = opts.project;
    }
    if (opts.kinds?.length) {
      where.push(`n.memory_kind IN (${opts.kinds.map((_, i) => `@k${i}`).join(",")})`);
      opts.kinds.forEach((k, i) => (params[`k${i}`] = k));
    }
    if (opts.types?.length) {
      where.push(`n.type IN (${opts.types.map((_, i) => `@t${i}`).join(",")})`);
      opts.types.forEach((t, i) => (params[`t${i}`] = t));
    }
    // `as_of` carries its own liveness rule — a node that was valid then belongs in the
    // answer even if it has since been invalidated — so it replaces the history flag.
    if (opts.asOf !== undefined) {
      where.push(
        "n.created_at <= @asOf AND (n.invalidated_at IS NULL OR n.invalidated_at > @asOf)",
      );
      params.asOf = opts.asOf;
    } else if (!opts.history) {
      where.push("n.invalidated_at IS NULL");
    }
    const clause = where.join(" AND ");

    const rows = this.db
      .prepare(
        `SELECT n.id, n.memory_kind, n.type, n.title, n.project, n.valid_from, n.invalidated_at,
                lr.rev AS rev, lr.ts AS updated, lr.content AS content,
                (SELECT COUNT(*) FROM edges e WHERE (e.src = n.id OR e.dst = n.id) AND e.invalidated_at IS NULL) AS edge_count,
                n.use_count, n.last_used_at,
                bm25(node_fts) AS bm25
         FROM node_fts
         JOIN nodes n ON n.id = node_fts.node_id
         JOIN (SELECT node_id, MAX(rev) AS mrev FROM revisions GROUP BY node_id) m ON m.node_id = n.id
         JOIN revisions lr ON lr.node_id = n.id AND lr.rev = m.mrev
         WHERE ${clause}
         ORDER BY bm25(node_fts)
         LIMIT @cap`,
      )
      .all({ ...params, cap: opts.cap }) as SearchRow[];

    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM node_fts JOIN nodes n ON n.id = node_fts.node_id WHERE ${clause}`,
        )
        .get(params) as { c: number }
    ).c;

    return { rows, total };
  }

  // Rows for ids the graph surfaced — the same shape the two candidate branches return, so
  // graph hits go through the identical scoring and envelope path.
  rowsFor(ids: string[], asOf?: string): EnrichedRow[] {
    if (!ids.length) return [];

    if (asOf === undefined) {
      return enrichedByIds(this.db, ids).filter((r) => r.invalidated_at == null);
    }

    const ph = ids.map(() => "?").join(",");

    return this.db
      .prepare(
        `${ENRICHED} WHERE n.id IN (${ph})
         AND n.created_at <= ? AND (n.invalidated_at IS NULL OR n.invalidated_at > ?)`,
      )
      .all(...ids, asOf, asOf) as EnrichedRow[];
  }

  // Best (lowest-seq) chunk vector per node — the same seed convention the consolidation
  // kNN uses. Nodes whose chunks are still queued for embedding are simply absent.
  vectorsFor(ids: string[]): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();

    if (!ids.length) return out;

    const ph = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT c.node_id AS id, cv.embedding AS embedding FROM chunks c
         JOIN chunk_vec cv ON cv.chunk_id = c.id
         WHERE c.stale = 0 AND c.node_id IN (${ph})
         ORDER BY c.node_id, c.seq`,
      )
      .all(...ids) as { id: string; embedding: Buffer }[];

    for (const r of rows) {
      if (out.has(r.id)) continue;
      out.set(
        r.id,
        new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.length / 4),
      );
    }

    return out;
  }

  private projectClause(project: string | undefined, params: Record<string, unknown>): string {
    if (project === undefined) return "";
    params.project = project;
    return " AND n.project = @project";
  }

  validSemantic(project: string | undefined, limit: number): Envelope[] {
    const params: Record<string, unknown> = { limit };
    const clause = this.projectClause(project, params);
    return (
      this.db
        .prepare(
          `${ENRICHED} WHERE n.memory_kind = 'semantic' AND n.type != 'task' AND n.invalidated_at IS NULL${clause}
           ORDER BY lr.ts DESC LIMIT @limit`,
        )
        .all(params) as EnrichedRow[]
    ).map(toEnvelope);
  }

  lastCheckpoints(
    project: string | undefined,
    limit: number,
  ): { envelope: Envelope; content: string }[] {
    const params: Record<string, unknown> = { limit };
    const clause = this.projectClause(project, params);
    return (
      this.db
        .prepare(
          `${ENRICHED} WHERE n.type = 'checkpoint' AND n.invalidated_at IS NULL${clause}
           ORDER BY lr.ts DESC LIMIT @limit`,
        )
        .all(params) as EnrichedRow[]
    ).map((r) => ({ envelope: toEnvelope(r), content: r.content }));
  }

  validTasks(project: string | undefined, limit: number): Envelope[] {
    const params: Record<string, unknown> = { limit };
    const clause = this.projectClause(project, params);
    return (
      this.db
        .prepare(
          `${ENRICHED} WHERE n.type = 'task' AND n.invalidated_at IS NULL${clause}
           ORDER BY lr.ts DESC LIMIT @limit`,
        )
        .all(params) as EnrichedRow[]
    ).map(toEnvelope);
  }

  recentValid(project: string | undefined, limit: number): Envelope[] {
    const params: Record<string, unknown> = { limit };
    const clause = this.projectClause(project, params);
    // Exclude code mirrors: the orient view is authored memory, not the (potentially
    // huge) symbol index, which is reached via search/code_lookup instead.
    return (
      this.db
        .prepare(
          `${ENRICHED} WHERE n.invalidated_at IS NULL AND n.memory_kind != 'mirror'${clause} ORDER BY lr.ts DESC LIMIT @limit`,
        )
        .all(params) as EnrichedRow[]
    ).map(toEnvelope);
  }
}
