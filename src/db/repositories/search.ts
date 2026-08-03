import { injectable } from "tsyringe";
import { BaseRepo } from "@/db/repositories/base";
import {
  AUTHORED_VEC,
  CODE_VEC,
  ENRICHED,
  enrichedByIds,
  LATEST_REVISION,
  type VectorPool,
} from "@/db/repositories/internal";
import type { EnrichedRow, Envelope, SearchRow, VectorRow } from "@/core/types";
import { toEnvelope } from "@/core/types";
import { MemoryKind, SYMBOL_TYPE } from "@/core/vocab";

// KNN over-fetch per pool: pull this many nearest chunks, then filter + collapse to the
// best chunk per node. The two pools carry different budgets because they are different
// sizes. The authored pool is a few hundred chunks, where 1000 sweeps all of it for ~5 ms
// and every live authored node becomes a candidate for every query — the post-filter can
// no longer starve. The code pool is six orders larger, where k is not free (200 -> 1000
// costs 110 -> 270 ms), so it keeps the over-fetch it was calibrated with.
// sqlite-vec caps k at 4096.
const VEC_K = 1000;
const CODE_VEC_K = 200;

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
      validAt?: string;
    },
  ): VectorRow[] {
    const where: string[] = ["c.stale = 0"];
    const params: Record<string, unknown> = {
      q: JSON.stringify(embedding),
      k: VEC_K,
      ck: CODE_VEC_K,
    };
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

    // Event axis. A node with no claimed window is an open interval, not an unknown to be
    // filtered out — 125k nodes predate the axis and excluding them would empty the answer.
    if (opts.validAt !== undefined) {
      where.push(
        "(n.event_from IS NULL OR n.event_from <= @validAt) AND (n.event_to IS NULL OR n.event_to > @validAt)",
      );
      params.validAt = opts.validAt;
    }

    const knn = this.poolsFor(opts)
      .map(
        (pool) =>
          `SELECT chunk_id, distance FROM ${pool} WHERE embedding MATCH @q AND k = ${
            pool === CODE_VEC ? "@ck" : "@k"
          }`,
      )
      .join(" UNION ALL ");

    const rows = this.db
      .prepare(
        `WITH knn AS (${knn})
         SELECT n.id, n.memory_kind, n.type, n.title, n.project, n.valid_from, n.invalidated_at,
                lr.rev AS rev, lr.ts AS updated, lr.content AS content,
                (SELECT COUNT(*) FROM edges e WHERE (e.src = n.id OR e.dst = n.id) AND e.invalidated_at IS NULL) AS edge_count,
                n.use_count, n.last_used_at,
                knn.distance AS distance, c.text AS chunk_text, c.heading_path AS chunk_heading
         FROM knn
         JOIN chunks c ON c.id = knn.chunk_id
         JOIN nodes n ON n.id = c.node_id
         ${LATEST_REVISION}
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

  // Which vector pools a query has to sweep. Skipping `code_vec` is the whole point of the
  // split: it is ~150x the other table, and a query that cannot return a code symbol has no
  // reason to spend k slots there. `types` narrows harder than `kinds` because `symbol` is
  // the only code type, while `mirror` also covers the curated external records.
  private poolsFor(opts: { kinds?: string[]; types?: string[] }): VectorPool[] {
    if (opts.types?.length && opts.types.every((t) => t === SYMBOL_TYPE)) {
      return [CODE_VEC];
    }

    if (opts.kinds?.length && !opts.kinds.includes(MemoryKind.MIRROR)) {
      return [AUTHORED_VEC];
    }

    return [AUTHORED_VEC, CODE_VEC];
  }

  search(opts: {
    match: string;
    project?: string;
    kinds?: string[];
    types?: string[];
    history: boolean;
    cap: number;
    asOf?: string;
    validAt?: string;
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

    // Event axis. A node with no claimed window is an open interval, not an unknown to be
    // filtered out — 125k nodes predate the axis and excluding them would empty the answer.
    if (opts.validAt !== undefined) {
      where.push(
        "(n.event_from IS NULL OR n.event_from <= @validAt) AND (n.event_to IS NULL OR n.event_to > @validAt)",
      );
      params.validAt = opts.validAt;
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
         ${LATEST_REVISION}
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
  rowsFor(ids: string[], opts: { asOf?: string; validAt?: string } = {}): EnrichedRow[] {
    if (!ids.length) return [];

    if (opts.asOf === undefined && opts.validAt === undefined) {
      return enrichedByIds(this.db, ids).filter((r) => r.invalidated_at == null);
    }

    const where = [`n.id IN (${ids.map((_, i) => `@i${i}`).join(",")})`];
    const params: Record<string, string> = Object.fromEntries(ids.map((id, i) => [`i${i}`, id]));

    if (opts.asOf !== undefined) {
      where.push(
        "n.created_at <= @asOf AND (n.invalidated_at IS NULL OR n.invalidated_at > @asOf)",
      );
      params.asOf = opts.asOf;
    } else {
      where.push("n.invalidated_at IS NULL");
    }

    if (opts.validAt !== undefined) {
      where.push(
        "(n.event_from IS NULL OR n.event_from <= @validAt) AND (n.event_to IS NULL OR n.event_to > @validAt)",
      );
      params.validAt = opts.validAt;
    }

    return this.db.prepare(`${ENRICHED} WHERE ${where.join(" AND ")}`).all(params) as EnrichedRow[];
  }

  // Best (lowest-seq) chunk vector per node — the same seed convention the consolidation
  // kNN uses. Nodes whose chunks are still queued for embedding are simply absent. Ids come
  // from a finished search and may span both pools, so each is queried in turn rather than
  // unioned: a UNION would make the planner scan a 126k-row vec0 table for a handful of ids.
  vectorsFor(ids: string[]): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();

    if (!ids.length) return out;

    const ph = ids.map(() => "?").join(",");

    for (const pool of [AUTHORED_VEC, CODE_VEC]) {
      const rows = this.db
        .prepare(
          `SELECT c.node_id AS id, v.embedding AS embedding FROM chunks c
           JOIN ${pool} v ON v.chunk_id = c.id
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
