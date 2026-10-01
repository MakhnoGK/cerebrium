import type { GraphEdge, GraphNode } from "@cerebrium/contracts/graph";

export const GRAPH_REPO_TOKEN = Symbol("GraphRepo");

export interface GraphRepo {
  snapshot(opts: {
    invalidated: boolean;
    symbols: boolean;
  }): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>;
}
