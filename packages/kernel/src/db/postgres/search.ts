import { injectable } from "tsyringe";
import type { EnrichedRow, Envelope, SearchRow, VectorRow } from "@cerebrium/contracts/types";
import { toEnvelope } from "@cerebrium/contracts/types";
import { SYMBOL_TYPE } from "@cerebrium/contracts/vocab";
import type { SearchFilters, SearchRepo } from "@/domain/ports/storage";
import { PgBaseRepo } from "@/db/postgres/base";
import type { Params } from "@/db/postgres/database";
import {
  ACTIVE_SPACE,
  ENRICHED,
  enrichedByIds,
  LATEST_REVISION,
  parseVector,
  toVectorLiteral,
} from "@/db/postgres/internal";
import { ACTIVE_EPISODIC } from "@/db/sql-fragments";
import type { TextQuery } from "@/core/fts";

// The same exact-KNN budget as the SQLite authored pool.
const VEC_K = 1000;

interface TextClause {
  from: string;
  match: string;
  rank: string;
}

@injectable()
export class PgSearchRepo extends PgBaseRepo implements SearchRepo {
  async vectorSearch(embedding: number[], opts: SearchFilters): Promise<VectorRow[]> {
    // The code pool does not exist on this backend.
    if (opts.types?.length && opts.types.every((t) => t === SYMBOL_TYPE)) return [];

    const params: Params = { q: toVectorLiteral(embedding), k: VEC_K };
    const where = ["c.stale = 0", ...this.filters(opts, params)];

    const rows = await this.all<VectorRow>(
      `WITH knn AS (
         SELECT v.chunk_id, v.embedding <=> @q::vector AS distance
         FROM chunk_vectors v
         WHERE v.space_id = ${ACTIVE_SPACE}
         ORDER BY distance, v.chunk_id
         LIMIT @k
       )
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
       ORDER BY knn.distance ASC, c.id`,
      params,
    );

    const seen = new Set<string>();
    const best: VectorRow[] = [];

    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      best.push(r);
      if (best.length >= opts.cap) break;
    }

    return best;
  }

  async search(
    opts: SearchFilters & { text: TextQuery },
  ): Promise<{ rows: SearchRow[]; total: number }> {
    const params: Params = { cap: opts.cap };
    const text = this.textClause(opts.text, params, "node");
    const clause = [text.match, ...this.filters(opts, params)].join(" AND ");

    const rows = await this.all<SearchRow>(
      `SELECT n.id, n.memory_kind, n.type, n.title, n.project, n.valid_from, n.invalidated_at,
              lr.rev AS rev, lr.ts AS updated, lr.content AS content,
              (SELECT COUNT(*) FROM edges e WHERE (e.src = n.id OR e.dst = n.id) AND e.invalidated_at IS NULL) AS edge_count,
              n.use_count, n.last_used_at,
              -${text.rank} AS text_rank
       FROM ${text.from}
       JOIN nodes n ON n.id = nt.node_id
       ${LATEST_REVISION}
       WHERE ${clause}
       ORDER BY text_rank, n.id
       LIMIT @cap`,
      params,
    );

    const total = await this.one<{ c: number }>(
      `SELECT COUNT(*) AS c
       FROM ${text.from}
       JOIN nodes n ON n.id = nt.node_id
       WHERE ${clause}`,
      params,
    );

    return { rows, total: total?.c ?? 0 };
  }

  async rowsFor(
    ids: string[],
    opts: { asOf?: string; validAt?: string; activeSince?: string } = {},
  ): Promise<EnrichedRow[]> {
    if (!ids.length) return [];

    if (opts.asOf === undefined && opts.validAt === undefined && opts.activeSince === undefined) {
      return (await enrichedByIds(this.db, ids)).filter((r) => r.invalidated_at == null);
    }

    const params: Params = { ids };
    const where = ["n.id = ANY(@ids)"];

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

    if (opts.activeSince !== undefined) {
      where.push(ACTIVE_EPISODIC);
      params.activeSince = opts.activeSince;
    }

    return this.all<EnrichedRow>(`${ENRICHED} WHERE ${where.join(" AND ")}`, params);
  }

  async vectorsFor(ids: string[]): Promise<Map<string, Float32Array>> {
    const out = new Map<string, Float32Array>();

    if (!ids.length) return out;

    const rows = await this.all<{ id: string; embedding: string }>(
      `SELECT c.node_id AS id, v.embedding::text AS embedding FROM chunks c
       JOIN chunk_vectors v ON v.chunk_id = c.id AND v.space_id = ${ACTIVE_SPACE}
       WHERE c.stale = 0 AND c.node_id = ANY(@ids)
       ORDER BY c.node_id, c.seq`,
      { ids },
    );

    for (const r of rows) {
      if (!out.has(r.id)) out.set(r.id, parseVector(r.embedding));
    }

    return out;
  }

  async bestFtsChunksFor(
    ids: string[],
    text: TextQuery,
  ): Promise<Map<string, { chunk_text: string; chunk_heading: string | null }>> {
    const out = new Map<string, { chunk_text: string; chunk_heading: string | null }>();

    if (!ids.length) return out;

    const params: Params = { ids };
    const clause = this.textClause(text, params, "chunk");
    const rows = await this.all<{ id: string; chunk_text: string; chunk_heading: string | null }>(
      `SELECT c.node_id AS id, c.text AS chunk_text, c.heading_path AS chunk_heading
       FROM ${clause.from}
       WHERE ${clause.match} AND c.node_id = ANY(@ids) AND c.stale = 0
       ORDER BY c.node_id, ${clause.rank} DESC, c.seq`,
      params,
    );

    for (const r of rows) {
      if (!out.has(r.id)) {
        out.set(r.id, { chunk_text: r.chunk_text, chunk_heading: r.chunk_heading });
      }
    }

    return out;
  }

  async validSemantic(project: string | undefined, limit: number): Promise<Envelope[]> {
    return (
      await this.recent(
        "n.memory_kind = 'semantic' AND n.type != 'task' AND n.invalidated_at IS NULL",
        project,
        limit,
      )
    ).map(toEnvelope);
  }

  async lastCheckpoints(
    project: string | undefined,
    limit: number,
  ): Promise<{ envelope: Envelope; content: string }[]> {
    return (
      await this.recent("n.type = 'checkpoint' AND n.invalidated_at IS NULL", project, limit)
    ).map((r) => ({ envelope: toEnvelope(r), content: r.content }));
  }

  async validTasks(project: string | undefined, limit: number): Promise<Envelope[]> {
    return (await this.recent("n.type = 'task' AND n.invalidated_at IS NULL", project, limit)).map(
      toEnvelope,
    );
  }

  async recentValid(project: string | undefined, limit: number): Promise<Envelope[]> {
    return (
      await this.recent("n.invalidated_at IS NULL AND n.memory_kind != 'mirror'", project, limit)
    ).map(toEnvelope);
  }

  // BM25 over a node's title and body (`nt`) or one chunk (`c`): a one-word term matches
  // its stemmed token, a multi-word term as a phrase, and the terms are OR-ed.
  private textClause(text: TextQuery, params: Params, target: "node" | "chunk"): TextClause {
    const columns = target === "node" ? ["nt.title", "nt.body"] : ["c.text"];
    const match = text
      .flatMap((words, i) => {
        const name = `t${String(i)}`;

        params[name] = words.join(" ");

        return columns.map((col) => `${col} ${words.length > 1 ? "###" : "|||"} @${name}`);
      })
      .join(" OR ");

    return target === "node"
      ? { from: "node_text nt", match: `(${match})`, rank: "pdb.score(nt.node_id)" }
      : { from: "chunks c", match: `(${match})`, rank: "pdb.score(c.id)" };
  }

  private filters(opts: SearchFilters, params: Params): string[] {
    const where: string[] = [];

    if (opts.project !== undefined) {
      where.push("n.project = @project");
      params.project = opts.project;
    }

    if (opts.kinds?.length) {
      where.push("n.memory_kind = ANY(@kinds)");
      params.kinds = opts.kinds;
    }

    if (opts.types?.length) {
      where.push("n.type = ANY(@types)");
      params.types = opts.types;
    }

    if (opts.asOf !== undefined) {
      where.push(
        "n.created_at <= @asOf AND (n.invalidated_at IS NULL OR n.invalidated_at > @asOf)",
      );
      params.asOf = opts.asOf;
    } else if (!opts.history) {
      where.push("n.invalidated_at IS NULL");
    }

    if (opts.validAt !== undefined) {
      where.push(
        "(n.event_from IS NULL OR n.event_from <= @validAt) AND (n.event_to IS NULL OR n.event_to > @validAt)",
      );
      params.validAt = opts.validAt;
    }

    if (opts.activeSince !== undefined) {
      where.push(ACTIVE_EPISODIC);
      params.activeSince = opts.activeSince;
    }

    return where;
  }

  private async recent(
    where: string,
    project: string | undefined,
    limit: number,
  ): Promise<EnrichedRow[]> {
    const params: Params = { limit };
    let clause = where;

    if (project !== undefined) {
      clause += " AND n.project = @project";
      params.project = project;
    }

    return this.all<EnrichedRow>(
      `${ENRICHED} WHERE ${clause} ORDER BY lr.ts DESC, n.id DESC LIMIT @limit`,
      params,
    );
  }
}
