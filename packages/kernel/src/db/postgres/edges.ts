import { injectable } from "tsyringe";
import type { Neighbor, NeighborStub } from "@cerebrium/contracts/types";
import { EdgeType } from "@cerebrium/contracts/vocab";
import type { EdgesRepo, SubgraphEdge } from "@/domain/ports/storage";
import { PgBaseRepo } from "@/db/postgres/base";
import {
  edgesOf,
  enrichedByIds,
  insertEdge,
  invalidateEdge,
  invalidateSystemSimilaritiesOf,
} from "@/db/postgres/internal";

@injectable()
export class PgEdgesRepo extends PgBaseRepo implements EdgesRepo {
  async insertEdge(
    src: string,
    dst: string,
    type: EdgeType,
    provenance: "agent" | "system",
    session_id: string,
    ts: string,
    weight = 1.0,
  ): Promise<void> {
    await this.tx(() => insertEdge(this.db, src, dst, type, provenance, session_id, ts, weight));
  }

  async insertSystemSimilarityIfLive(
    src: string,
    dst: string,
    session_id: string,
    ts: string,
    weight: number,
  ): Promise<boolean> {
    return this.insertSystemEdgeIfLive(EdgeType.SIMILAR_TO, src, dst, session_id, ts, weight);
  }

  async insertDuplicateOfIfLive(
    duplicate: string,
    representative: string,
    session_id: string,
    ts: string,
    weight: number,
  ): Promise<boolean> {
    return this.insertSystemEdgeIfLive(
      EdgeType.DUPLICATE_OF,
      duplicate,
      representative,
      session_id,
      ts,
      weight,
    );
  }

  // `INSERT … SELECT @param` gives a bare parameter no type to infer, so each is cast.
  async insertSystemReferenceIfUnconnected(
    src: string,
    dst: string,
    session_id: string,
    ts: string,
  ): Promise<boolean> {
    const inserted = await this.run(
      `INSERT INTO edges (src, dst, type, provenance, weight, valid_from, session_id)
       SELECT @src::text, @dst::text, @type::text, 'system', 1.0, @ts::text, @session::text
       WHERE EXISTS (SELECT 1 FROM nodes WHERE id = @src AND invalidated_at IS NULL)
         AND EXISTS (SELECT 1 FROM nodes WHERE id = @dst AND invalidated_at IS NULL)
         AND NOT EXISTS (
           SELECT 1 FROM edges e
           WHERE e.invalidated_at IS NULL
             AND ((e.src = @src AND e.dst = @dst) OR (e.src = @dst AND e.dst = @src))
         )
       ON CONFLICT (src, dst, type) DO NOTHING`,
      { src, dst, type: EdgeType.REFERENCES, ts, session: session_id },
    );

    return inserted > 0;
  }

  async insertSystemEdgeIfUnconnected(
    type: EdgeType,
    src: string,
    dst: string,
    session_id: string,
    ts: string,
    weight: number,
  ): Promise<boolean> {
    const inserted = await this.run(
      `INSERT INTO edges (src, dst, type, provenance, weight, valid_from, session_id)
       SELECT @src::text, @dst::text, @type::text, 'system', @weight::float8, @ts::text, @session::text
       WHERE @src::text <> @dst::text
         AND EXISTS (SELECT 1 FROM nodes WHERE id = @src AND invalidated_at IS NULL)
         AND EXISTS (SELECT 1 FROM nodes WHERE id = @dst AND invalidated_at IS NULL)
         AND NOT EXISTS (
           SELECT 1 FROM edges e
           WHERE e.invalidated_at IS NULL
             AND ((e.src = @src AND e.dst = @dst) OR (e.src = @dst AND e.dst = @src))
         )
       ON CONFLICT (src, dst, type) DO UPDATE SET
         invalidated_at = NULL, valid_from = excluded.valid_from, weight = excluded.weight,
         provenance = excluded.provenance, session_id = excluded.session_id`,
      { src, dst, type, weight, ts, session: session_id },
    );

    return inserted > 0;
  }

  async pairIsConnected(a: string, b: string): Promise<boolean> {
    return (
      (await this.one(
        `SELECT 1 FROM edges
         WHERE invalidated_at IS NULL
           AND ((src = @a AND dst = @b) OR (src = @b AND dst = @a))
         LIMIT 1`,
        { a, b },
      )) !== undefined
    );
  }

  async insertSystemDocumentsIfLive(
    note: string,
    symbol: string,
    session_id: string,
    ts: string,
  ): Promise<boolean> {
    return this.insertSystemEdgeIfLive(EdgeType.DOCUMENTS, note, symbol, session_id, ts, 1.0);
  }

  private async insertSystemEdgeIfLive(
    type: EdgeType,
    src: string,
    dst: string,
    session_id: string,
    ts: string,
    weight: number,
  ): Promise<boolean> {
    const inserted = await this.run(
      `INSERT INTO edges (src, dst, type, provenance, weight, valid_from, session_id)
       SELECT @src::text, @dst::text, @type::text, 'system', @weight::float8, @ts::text, @session::text
       WHERE EXISTS (SELECT 1 FROM nodes WHERE id = @src AND invalidated_at IS NULL)
         AND EXISTS (SELECT 1 FROM nodes WHERE id = @dst AND invalidated_at IS NULL)
       ON CONFLICT (src, dst, type) DO UPDATE SET
         invalidated_at = NULL, valid_from = excluded.valid_from,
         weight = excluded.weight, provenance = excluded.provenance`,
      { src, dst, type, weight, ts, session: session_id },
    );

    return inserted > 0;
  }

  async invalidateSystemSimilaritiesOf(id: string, ts: string): Promise<number> {
    return this.tx(() => invalidateSystemSimilaritiesOf(this.db, id, ts));
  }

  async invalidateEdge(src: string, dst: string, type: EdgeType, ts: string): Promise<void> {
    await this.tx(() => invalidateEdge(this.db, src, dst, type, ts));
  }

  async edgesOf(id: string): Promise<NeighborStub[]> {
    return edgesOf(this.db, id);
  }

  async neighborsOf(parentIds: string[]): Promise<Neighbor[]> {
    if (!parentIds.length) return [];

    const edges = await this.all<{ src: string; dst: string; type: EdgeType }>(
      `SELECT src, dst, type FROM edges
       WHERE invalidated_at IS NULL AND (src = ANY(@ids) OR dst = ANY(@ids))
       ORDER BY src, dst, type`,
      { ids: parentIds },
    );

    const parents = new Set(parentIds);
    const pairs: { parent: string; edge: EdgeType; neighborId: string }[] = [];

    for (const e of edges) {
      if (parents.has(e.src)) pairs.push({ parent: e.src, edge: e.type, neighborId: e.dst });
      if (parents.has(e.dst)) pairs.push({ parent: e.dst, edge: e.type, neighborId: e.src });
    }

    const byId = new Map(
      (await enrichedByIds(this.db, [...new Set(pairs.map((p) => p.neighborId))]))
        .filter((r) => r.invalidated_at == null)
        .map((r) => [r.id, r] as const),
    );
    const out: Neighbor[] = [];

    for (const p of pairs) {
      const node = byId.get(p.neighborId);
      if (node) out.push({ parent: p.parent, edge: p.edge, node });
    }

    return out;
  }

  // Postgres allows one recursive reference per CTE, so both hop directions come from one
  // LATERAL rather than from two UNIONed recursive terms.
  async subgraphFrom(
    seedIds: string[],
    opts: { depth: number; cap: number; types: string[]; asOf?: string; validAt?: string },
  ): Promise<SubgraphEdge[]> {
    if (!seedIds.length || !opts.types.length) return [];

    const params: Record<string, unknown> = {
      seeds: seedIds,
      types: opts.types,
      depth: opts.depth,
      cap: opts.cap,
    };

    if (opts.asOf !== undefined) params.asOf = opts.asOf;
    if (opts.validAt !== undefined) params.validAt = opts.validAt;

    const nodeLive = [
      opts.asOf === undefined
        ? "n.invalidated_at IS NULL"
        : "n.created_at <= @asOf AND (n.invalidated_at IS NULL OR n.invalidated_at > @asOf)",
      ...(opts.validAt === undefined
        ? []
        : [
            "(n.event_from IS NULL OR n.event_from <= @validAt) AND (n.event_to IS NULL OR n.event_to > @validAt)",
          ]),
    ].join(" AND ");
    const edgeLive =
      opts.asOf === undefined
        ? "e.invalidated_at IS NULL"
        : "e.valid_from <= @asOf AND (e.invalidated_at IS NULL OR e.invalidated_at > @asOf)";

    return this.all<SubgraphEdge>(
      `WITH RECURSIVE
       reach(id, depth) AS (
         SELECT n.id, 0 FROM nodes n WHERE n.id = ANY(@seeds) AND ${nodeLive}
         UNION
         SELECT hop.id, reach.depth + 1
         FROM reach
         CROSS JOIN LATERAL (
           SELECT e.dst AS id FROM edges e
            WHERE e.src = reach.id AND ${edgeLive} AND e.type = ANY(@types)
           UNION ALL
           SELECT e.src AS id FROM edges e
            WHERE e.dst = reach.id AND ${edgeLive} AND e.type = ANY(@types)
         ) hop
         JOIN nodes n ON n.id = hop.id AND ${nodeLive}
         WHERE reach.depth < @depth
       ),
       frontier AS (
         SELECT id FROM (SELECT id, MIN(depth) AS d FROM reach GROUP BY id) ranked
          ORDER BY d ASC, id ASC LIMIT @cap
       )
       SELECT e.src AS src, e.dst AS dst, e.type AS type, e.weight AS weight
       FROM frontier f
       JOIN edges e ON e.src = f.id
       WHERE ${edgeLive} AND e.type = ANY(@types)
         AND e.dst IN (SELECT id FROM frontier)
       ORDER BY e.src, e.dst, e.type`,
      params,
    );
  }

  async supersededInfo(ids: string[]): Promise<Map<string, { by: string; at: string }>> {
    const map = new Map<string, { by: string; at: string }>();

    if (!ids.length) return map;

    const rows = await this.all<{ id: string; by: string; at: string }>(
      `SELECT e.dst AS id, e.src AS by, n.invalidated_at AS at
       FROM edges e JOIN nodes n ON n.id = e.dst
       WHERE e.type = 'supersedes' AND e.invalidated_at IS NULL
         AND e.dst = ANY(@ids) AND n.invalidated_at IS NOT NULL
       ORDER BY e.dst, e.src`,
      { ids },
    );

    for (const r of rows) map.set(r.id, { by: r.by, at: r.at });

    return map;
  }

  async supersedesPairs(ids: string[]): Promise<Set<string>> {
    return this.pairsOfType(EdgeType.SUPERSEDES, ids);
  }

  async duplicatePairs(ids: string[]): Promise<Set<string>> {
    return this.pairsOfType(EdgeType.DUPLICATE_OF, ids);
  }

  private async pairsOfType(type: EdgeType, ids: string[]): Promise<Set<string>> {
    const out = new Set<string>();

    if (ids.length < 2) return out;

    const rows = await this.all<{ src: string; dst: string }>(
      `SELECT src, dst FROM edges
       WHERE type = @type AND invalidated_at IS NULL
         AND src = ANY(@ids) AND dst = ANY(@ids)`,
      { type, ids },
    );

    for (const r of rows) {
      out.add(r.src < r.dst ? `${r.src}|${r.dst}` : `${r.dst}|${r.src}`);
    }

    return out;
  }

  async liveSuccessorsOf(id: string): Promise<string[]> {
    return (
      await this.all<{ src: string }>(
        `SELECT src FROM edges
         WHERE dst = @id AND type = 'supersedes' AND invalidated_at IS NULL
         ORDER BY valid_from DESC, src ASC`,
        { id },
      )
    ).map((row) => row.src);
  }
}
