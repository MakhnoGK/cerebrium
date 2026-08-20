import { EDGE_WEIGHTS, PPR_EPSILON, PPR_ITERS } from "@/application/retrieval/constants";
import type { EdgeType } from "@/core/vocab";

// Personalized PageRank over the local subgraph: r = (1-alpha)·p + alpha·W·r, with W the
// degree-normalized conductance matrix (edge-type weight × the edge's stored weight).
// Degree normalization is what stops a hub from swallowing the diffusion. Alongside the
// ranks it returns, per node, the single largest contributor — the honest answer to "why
// did this surface", which is what the `via` field reports.
export function personalizedPageRank(
  edges: { src: string; dst: string; type: EdgeType; weight: number }[],
  personalization: Map<string, number>,
  alpha: number,
): { ranks: Map<string, number>; contributor: Map<string, { node: string; edge: string }> } {
  const adjacency = new Map<string, { to: string; edge: EdgeType; conductance: number }[]>();
  const degree = new Map<string, number>();

  const connect = (from: string, to: string, edge: EdgeType, conductance: number) => {
    const list = adjacency.get(from);

    if (list) list.push({ to, edge, conductance });
    else adjacency.set(from, [{ to, edge, conductance }]);

    degree.set(from, (degree.get(from) ?? 0) + conductance);
  };

  for (const e of edges) {
    const conductance = (EDGE_WEIGHTS[e.type] ?? 0) * (e.weight || 1);

    if (conductance <= 0 || e.src === e.dst) continue;

    connect(e.src, e.dst, e.type, conductance);
    connect(e.dst, e.src, e.type, conductance);
  }

  const total = [...personalization.values()].reduce((a, b) => a + b, 0);

  if (!adjacency.size || total <= 0) {
    return { ranks: new Map(), contributor: new Map() };
  }

  const p = new Map([...personalization].map(([id, v]) => [id, v / total]));
  let ranks = new Map(p);
  const contributor = new Map<string, { node: string; edge: string }>();

  for (let iteration = 0; iteration < PPR_ITERS; iteration++) {
    const next = new Map<string, number>();
    const bestInflow = new Map<string, number>();

    for (const [id, mass] of ranks) {
      const out = adjacency.get(id);
      const deg = degree.get(id);

      if (!out || !deg || mass <= 0) continue;

      for (const edge of out) {
        const inflow = alpha * mass * (edge.conductance / deg);

        next.set(edge.to, (next.get(edge.to) ?? 0) + inflow);

        if (inflow > (bestInflow.get(edge.to) ?? 0)) {
          bestInflow.set(edge.to, inflow);
          contributor.set(edge.to, { node: id, edge: edge.edge });
        }
      }
    }

    for (const [id, seed] of p) {
      next.set(id, (next.get(id) ?? 0) + (1 - alpha) * seed);
    }

    let delta = 0;

    for (const id of new Set([...ranks.keys(), ...next.keys()])) {
      delta += Math.abs((next.get(id) ?? 0) - (ranks.get(id) ?? 0));
    }

    ranks = next;

    if (delta < PPR_EPSILON) break;
  }

  return { ranks, contributor };
}
