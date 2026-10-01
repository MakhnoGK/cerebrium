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
} from "@/db/graph-rows";
import { PgBaseRepo } from "@/db/postgres/base";

interface RefRow {
  src: string;
  type: string;
  repo: string;
  remote_key: string | null;
  path: string;
  qualified: string;
  symbol_kind: string;
  symbol_live: number;
}

// Symbols live per branch outside `nodes`; a note's citation of one is a `code_refs` row,
// so the symbol's id here is minted from the ref's target.
@injectable()
export class PgGraphRepo extends PgBaseRepo implements GraphRepo {
  async snapshot(opts: {
    invalidated: boolean;
    symbols: boolean;
  }): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const nodes = (
      await this.all<GraphNodeRow>(GRAPH_NODES, { invalidated: opts.invalidated ? 1 : 0 })
    ).map(graphNodeOf);
    const edges = await this.all<GraphEdge & { weight: number }>(GRAPH_EDGES);

    if (opts.symbols) {
      const refs = await this.all<RefRow>(
        `SELECT r.src, r.type, r.repo, r.remote_key, r.path, r.qualified, r.symbol_kind,
                r.symbol_live
           FROM code_refs r JOIN nodes n ON n.id = r.src
          WHERE r.invalidated_at IS NULL AND n.memory_kind IN ('semantic', 'episodic')
          ORDER BY r.src, r.repo, r.qualified`,
      );
      const symbols = new Map<string, GraphNode>();

      for (const ref of refs) {
        const id = `code:${ref.remote_key ?? ref.repo}:${ref.qualified}`;

        if (!symbols.has(id)) {
          symbols.set(id, symbolNodeOf({ ...ref, id, live: ref.symbol_live === 1 }));
        }

        edges.push({ src: ref.src, dst: id, type: ref.type, provenance: "code_ref", weight: 1 });
      }

      nodes.push(...symbols.values());
    }

    return { nodes, edges: connected(nodes, edges) };
  }
}
