import type { GraphEdge, GraphNode, GraphNodeKind } from "@cerebrium/contracts/graph";
import { deriveSummary } from "@cerebrium/contracts/types";

// Shared by both backends: the SELECT lists and the row shapes they return.

const AUTHORED = "('semantic', 'episodic')";
const HEAD_CHARS = 2000;

// Live authored nodes, the invalidated ones a live edge from a live node still points at,
// and with `@invalidated = 1` every invalidated one.
export const GRAPH_NODES = `
  SELECT n.id, n.memory_kind AS kind, n.type, n.title, n.project, n.invalidated_at,
         lr.ts AS updated, substr(lr.content, 1, ${HEAD_CHARS}) AS head
    FROM nodes n
    JOIN revisions lr ON lr.node_id = n.id
     AND lr.rev = (SELECT MAX(r.rev) FROM revisions r WHERE r.node_id = n.id)
   WHERE n.memory_kind IN ${AUTHORED}
     AND (n.invalidated_at IS NULL OR @invalidated = 1 OR EXISTS (
           SELECT 1 FROM edges e JOIN nodes s ON s.id = e.src
            WHERE e.dst = n.id AND e.invalidated_at IS NULL AND e.type <> 'supersedes'
              AND s.invalidated_at IS NULL AND s.memory_kind IN ${AUTHORED}))
   ORDER BY n.id`;

export const GRAPH_EDGES = `
  SELECT e.src, e.dst, e.type, e.provenance, e.weight
    FROM edges e JOIN nodes s ON s.id = e.src
   WHERE e.invalidated_at IS NULL AND s.memory_kind IN ${AUTHORED}
   ORDER BY e.src, e.dst, e.type`;

export interface GraphNodeRow {
  id: string;
  kind: GraphNodeKind;
  type: string;
  title: string;
  project: string | null;
  invalidated_at: string | null;
  updated: string;
  head: string;
}

export interface SymbolRow {
  id: string;
  repo: string;
  path: string;
  qualified: string;
  symbol_kind: string;
  live: boolean;
}

export function graphNodeOf(row: GraphNodeRow): GraphNode {
  return {
    id: row.id,
    kind: row.kind,
    type: row.type,
    title: row.title,
    summary: deriveSummary(row.head),
    project: row.project,
    updated: row.updated,
    invalidated: row.invalidated_at !== null,
  };
}

export function symbolNodeOf(row: SymbolRow): GraphNode {
  return {
    id: row.id,
    kind: "symbol",
    type: row.symbol_kind,
    title: row.qualified.slice(row.qualified.lastIndexOf(":") + 1) || row.qualified,
    summary: row.path,
    project: row.repo,
    updated: null,
    invalidated: !row.live,
  };
}

// Only the edges whose both ends made it into the picture.
export function connected(nodes: GraphNode[], edges: GraphEdge[]): GraphEdge[] {
  const ids = new Set(nodes.map((n) => n.id));

  return edges.filter((e) => ids.has(e.src) && ids.has(e.dst));
}
