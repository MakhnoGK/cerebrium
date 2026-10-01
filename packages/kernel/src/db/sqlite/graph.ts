import { injectable } from "tsyringe";
import type { GraphEdge, GraphNode } from "@cerebrium/contracts/graph";
import type { GraphRepo } from "@/domain/ports/storage";
import {
  connected,
  GRAPH_EDGES,
  GRAPH_NODES,
  graphNodeOf,
  symbolNodeOf,
  type GraphNodeRow,
  type SymbolRow,
} from "@/db/graph-rows";
import { BaseRepo } from "@/db/sqlite/base";

@injectable()
export class SqliteGraphRepo extends BaseRepo implements GraphRepo {
  async snapshot(opts: {
    invalidated: boolean;
    symbols: boolean;
  }): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const nodes = (
      this.db.prepare(GRAPH_NODES).all({ invalidated: opts.invalidated ? 1 : 0 }) as GraphNodeRow[]
    ).map(graphNodeOf);
    const edges = this.db.prepare(GRAPH_EDGES).all() as GraphEdge[];

    if (opts.symbols) {
      const rows = this.db
        .prepare(
          `SELECT n.id, s.repo, s.path, s.qualified, s.symbol_kind,
                  n.invalidated_at IS NULL AS live
             FROM nodes n JOIN symbols s ON s.node_id = n.id
            WHERE n.id IN (SELECT e.dst FROM edges e JOIN nodes a ON a.id = e.src
                            WHERE e.invalidated_at IS NULL
                              AND a.memory_kind IN ('semantic', 'episodic'))
            ORDER BY n.id`,
        )
        .all() as (Omit<SymbolRow, "live"> & { live: number })[];

      nodes.push(...rows.map((r) => symbolNodeOf({ ...r, live: r.live === 1 })));
    }

    return { nodes, edges: connected(nodes, edges) };
  }
}
