import { injectable } from "tsyringe";
import { BaseRepo } from "@/db/repositories/base";
import { enrichedByIds } from "@/db/repositories/internal";
import type { Neighbor, NeighborStub } from "@/core/types";
import type { EdgeType } from "@/core/vocab";

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
}
