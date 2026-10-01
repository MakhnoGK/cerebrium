// The memory graph as one picture: what `graph_snapshot` answers and the dashboard draws.

export type GraphNodeKind = "episodic" | "semantic" | "symbol";

// A code symbol has no node row on every backend, so its id may be a key the snapshot
// mints (`code:<repo>:<qualified>`) rather than a node id.
export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  type: string;
  title: string;
  summary: string;
  project: string | null;
  updated: string | null;
  invalidated: boolean;
}

export interface GraphEdge {
  src: string;
  dst: string;
  type: string;
  provenance: string;
  weight: number;
}

export interface GraphQuery {
  // Every invalidated authored node, not only the ones a live edge still points at.
  invalidated?: boolean;
  // The code symbols authored nodes cite.
  symbols?: boolean;
}

export interface GraphSnapshot {
  generated_at: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphIntegrity {
  // Live authored nodes with no live edge to another live authored node.
  edgeless: ReadonlySet<string>;
  // Live authored nodes unreachable from the densest hub; the edgeless ones included.
  detached: ReadonlySet<string>;
  // Indexes into `edges`: live edges from a live node into an invalidated one.
  dangling: ReadonlySet<number>;
}

// The same three measures `stats` reports as graph health, over a snapshot.
export function graphIntegrity(snapshot: Pick<GraphSnapshot, "nodes" | "edges">): GraphIntegrity {
  const live = new Set<string>();
  const dead = new Set<string>();

  for (const node of snapshot.nodes) {
    if (node.kind === "symbol") continue;
    (node.invalidated ? dead : live).add(node.id);
  }

  const neighbors = new Map<string, Set<string>>();
  const dangling = new Set<number>();
  const edgeless = new Set(live);

  const join = (a: string, b: string) => {
    let set = neighbors.get(a);
    if (!set) neighbors.set(a, (set = new Set()));
    set.add(b);
  };

  snapshot.edges.forEach((edge, i) => {
    if (!live.has(edge.src)) return;

    if (dead.has(edge.dst)) {
      if (edge.type !== "supersedes") dangling.add(i);
      return;
    }

    if (!live.has(edge.dst)) return;

    join(edge.src, edge.dst);
    join(edge.dst, edge.src);

    if (edge.src !== edge.dst) {
      edgeless.delete(edge.src);
      edgeless.delete(edge.dst);
    }
  });

  let seed: string | null = null;
  let best = -1;

  for (const [id, set] of neighbors) {
    if (set.size > best || (set.size === best && seed !== null && id < seed)) {
      seed = id;
      best = set.size;
    }
  }

  const reached = new Set<string>();

  if (seed !== null) {
    const queue = [seed];
    reached.add(seed);

    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      for (const next of neighbors.get(id) ?? []) {
        if (!reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }
  }

  const detached = new Set(seed === null ? [] : [...live].filter((id) => !reached.has(id)));

  return { edgeless, detached, dangling };
}
