import { injectable } from "tsyringe";
import { BaseRepo } from "@/db/repositories/base";
import { enrichedByIds } from "@/db/repositories/internal";
import type { Neighbor, NeighborStub } from "@/core/types";
import { EdgeType } from "@/core/vocab";

// The typed knowledge graph: edge writes and graph reads (1-hop expansion,
// supersession lookups). Depends only on the shared enriched-row read helper, so it
// has no dependency on the other aggregate repos.
@injectable()
export class EdgesRepo extends BaseRepo {
  insertEdge(
    src: string,
    dst: string,
    type: EdgeType,
    provenance: "agent" | "system",
    session_id: string,
    ts: string,
    weight = 1.0,
  ): void {
    // Revive a previously-invalidated edge of the same (src,dst,type); otherwise insert.
    this.db
      .prepare(
        `INSERT INTO edges (src, dst, type, provenance, weight, valid_from, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(src, dst, type) DO UPDATE SET
           invalidated_at = NULL, valid_from = excluded.valid_from,
           weight = excluded.weight, provenance = excluded.provenance`,
      )
      .run(src, dst, type, provenance, weight, ts, session_id);
  }

  insertSystemSimilarityIfLive(
    src: string,
    dst: string,
    session_id: string,
    ts: string,
    weight: number,
  ): boolean {
    return this.tx(() => {
      const info = this.db
        .prepare(
          `INSERT INTO edges (src, dst, type, provenance, weight, valid_from, session_id)
           SELECT @src, @dst, @type, 'system', @weight, @ts, @session
           WHERE EXISTS (SELECT 1 FROM nodes WHERE id = @src AND invalidated_at IS NULL)
             AND EXISTS (SELECT 1 FROM nodes WHERE id = @dst AND invalidated_at IS NULL)
           ON CONFLICT(src, dst, type) DO UPDATE SET
             invalidated_at = NULL, valid_from = excluded.valid_from,
             weight = excluded.weight, provenance = excluded.provenance`,
        )
        .run({ src, dst, type: EdgeType.SIMILAR_TO, weight, ts, session: session_id });

      return info.changes > 0;
    });
  }

  invalidateSystemSimilaritiesOf(id: string, ts: string): number {
    return this.tx(
      () =>
        this.db
          .prepare(
            `UPDATE edges SET invalidated_at = @ts
             WHERE invalidated_at IS NULL AND type = @type AND provenance = 'system'
               AND (src = @id OR dst = @id)`,
          )
          .run({ id, ts, type: EdgeType.SIMILAR_TO }).changes,
    );
  }

  // Soft-delete one edge. insertEdge revives an invalidated (src,dst,type) on conflict,
  // so a retired edge comes back only if something deliberately re-inserts it.
  invalidateEdge(src: string, dst: string, type: EdgeType, ts: string): void {
    this.db
      .prepare(
        `UPDATE edges SET invalidated_at = ?
         WHERE src = ? AND dst = ? AND type = ? AND invalidated_at IS NULL`,
      )
      .run(ts, src, dst, type);
  }

  edgesOf(id: string): NeighborStub[] {
    const out = this.db
      .prepare(
        `SELECT e.type AS edge, n.id, n.type, n.title FROM edges e
         JOIN nodes n ON n.id = e.dst WHERE e.src = ? AND e.invalidated_at IS NULL`,
      )
      .all(id) as { edge: string; id: string; type: string; title: string }[];
    const inc = this.db
      .prepare(
        `SELECT e.type AS edge, n.id, n.type, n.title FROM edges e
         JOIN nodes n ON n.id = e.src WHERE e.dst = ? AND e.invalidated_at IS NULL`,
      )
      .all(id) as { edge: string; id: string; type: string; title: string }[];
    return [
      ...out.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        edge: r.edge,
        direction: "out" as const,
      })),
      ...inc.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        edge: r.edge,
        direction: "in" as const,
      })),
    ];
  }

  // 1-hop valid neighbors of the given nodes, over valid edges, neighbor valid only.
  neighborsOf(parentIds: string[]): Neighbor[] {
    if (!parentIds.length) return [];
    const ph = parentIds.map(() => "?").join(",");
    const edges = this.db
      .prepare(
        `SELECT src, dst, type FROM edges
         WHERE invalidated_at IS NULL AND (src IN (${ph}) OR dst IN (${ph}))`,
      )
      .all(...parentIds, ...parentIds) as { src: string; dst: string; type: EdgeType }[];

    const parents = new Set(parentIds);
    const pairs: { parent: string; edge: EdgeType; neighborId: string }[] = [];
    for (const e of edges) {
      if (parents.has(e.src)) pairs.push({ parent: e.src, edge: e.type, neighborId: e.dst });
      if (parents.has(e.dst)) pairs.push({ parent: e.dst, edge: e.type, neighborId: e.src });
    }
    const byId = new Map(
      enrichedByIds(this.db, [...new Set(pairs.map((p) => p.neighborId))])
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

  // The local subgraph reachable from `seedIds` within `depth` hops, over live edges of the
  // given types between live nodes — the input to PPR diffusion at search time. Edges are
  // returned with their stored `weight`, which plain 1-hop expansion never read. Traversal
  // is undirected: an edge relates its endpoints regardless of which way it was written.
  // `cap` bounds the node set (nearest first), so a hub can't turn one query into a scan.
  subgraphFrom(
    seedIds: string[],
    opts: { depth: number; cap: number; types: string[]; asOf?: string; validAt?: string },
  ): { src: string; dst: string; type: EdgeType; weight: number }[] {
    if (!seedIds.length || !opts.types.length) return [];

    // Named parameters throughout: the type list appears in three clauses and the as-of
    // instant in five, and binding each once is what keeps them in step.
    const params: Record<string, string | number> = { depth: opts.depth, cap: opts.cap };
    const seedPh = seedIds
      .map((id, i) => {
        params[`s${i}`] = id;
        return `@s${i}`;
      })
      .join(",");
    const typePh = opts.types
      .map((t, i) => {
        params[`t${i}`] = t;
        return `@t${i}`;
      })
      .join(",");

    if (opts.asOf !== undefined) params.asOf = opts.asOf;
    if (opts.validAt !== undefined) params.validAt = opts.validAt;
    // Under `as_of` the graph is the graph as it stood then: nodes that existed and were
    // still valid, joined by edges that had been written and not yet retired.
    const nodeLive = [
      opts.asOf === undefined
        ? "n.invalidated_at IS NULL"
        : "n.created_at <= @asOf AND (n.invalidated_at IS NULL OR n.invalidated_at > @asOf)",
      // The event axis applies to graph hits too: a node the query excluded as out of its
      // validity window must not come back in through diffusion.
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

    // There is no index on edges(type), so every clause is driven from node ids instead:
    // outward hops ride the (src,…) primary key, inward hops ride idx_edges_dst. Filtering
    // by type inside those lookups is free; filtering by type first is a 380k-row scan.
    const hop = (join: "src" | "dst") => `
      SELECT e.${join === "src" ? "dst" : "src"}, reach.depth + 1 FROM reach
      JOIN edges e ON e.${join} = reach.id
      JOIN nodes n ON n.id = e.${join === "src" ? "dst" : "src"} AND ${nodeLive}
      WHERE ${edgeLive} AND e.type IN (${typePh}) AND reach.depth < @depth`;

    return this.db
      .prepare(
        `WITH RECURSIVE
         reach(id, depth) AS (
           SELECT n.id, 0 FROM nodes n WHERE n.id IN (${seedPh}) AND ${nodeLive}
           UNION
           ${hop("src")}
           UNION
           ${hop("dst")}
         ),
         frontier AS (
           SELECT id FROM (SELECT id, MIN(depth) AS d FROM reach GROUP BY id)
            ORDER BY d ASC, id ASC LIMIT @cap
         )
         SELECT e.src AS src, e.dst AS dst, e.type AS type, e.weight AS weight
         FROM frontier f
         JOIN edges e ON e.src = f.id
         WHERE ${edgeLive} AND e.type IN (${typePh})
           AND e.dst IN (SELECT id FROM frontier)`,
      )
      .all(params) as {
      src: string;
      dst: string;
      type: EdgeType;
      weight: number;
    }[];
  }

  // For context_notes: which of these (invalidated) nodes were superseded, by whom, when.
  supersededInfo(ids: string[]): Map<string, { by: string; at: string }> {
    const map = new Map<string, { by: string; at: string }>();
    if (!ids.length) return map;
    const ph = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT e.dst AS id, e.src AS by, n.invalidated_at AS at
         FROM edges e JOIN nodes n ON n.id = e.dst
         WHERE e.type = 'supersedes' AND e.invalidated_at IS NULL
           AND e.dst IN (${ph}) AND n.invalidated_at IS NOT NULL`,
      )
      .all(...ids) as { id: string; by: string; at: string }[];
    for (const r of rows) map.set(r.id, { by: r.by, at: r.at });
    return map;
  }

  // Unordered `a|b` keys for every pair among `ids` joined by a live `supersedes` edge.
  // Unlike `supersededInfo` this does not require the superseded node to be invalidated —
  // a normal search never shows those, and the pairs that matter here are both live.
  supersedesPairs(ids: string[]): Set<string> {
    const out = new Set<string>();

    if (ids.length < 2) return out;

    const ph = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT src, dst FROM edges
         WHERE type = 'supersedes' AND invalidated_at IS NULL
           AND src IN (${ph}) AND dst IN (${ph})`,
      )
      .all(...ids, ...ids) as { src: string; dst: string }[];

    for (const r of rows) {
      out.add(r.src < r.dst ? `${r.src}|${r.dst}` : `${r.dst}|${r.src}`);
    }

    return out;
  }

  liveSuccessorsOf(id: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT src FROM edges
           WHERE dst = ? AND type = 'supersedes' AND invalidated_at IS NULL
           ORDER BY valid_from DESC, src ASC`,
        )
        .all(id) as { src: string }[]
    ).map((row) => row.src);
  }
}
