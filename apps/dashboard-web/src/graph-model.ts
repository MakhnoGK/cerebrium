import Graph from "graphology";
import type { ForceAtlas2Settings } from "graphology-layout-forceatlas2";
import type { GraphNode, GraphSnapshot } from "@cerebrium/contracts/graph";
import { truncate } from "./format";

export type ColorBy = "type" | "project";

export interface Palette {
  slots: readonly string[];
  other: string;
  symbol: string;
  retired: string;
  edge: string;
  edgeFaint: string;
  dim: string;
  pulse: string;
  dangling: string;
  detached: string;
  edgeless: string;
  label: string;
  surface: string;
}

const LIGHT: Palette = {
  slots: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7"],
  other: "#898781",
  symbol: "#b5b3ac",
  retired: "#d4d2cb",
  edge: "#c3c6cc",
  edgeFaint: "#e3e5e8",
  dim: "#e6e7ea",
  pulse: "#3b5bdb",
  dangling: "#d03b3b",
  detached: "#ec835a",
  edgeless: "#fab219",
  label: "#1a1e24",
  surface: "#ffffff",
};

const DARK: Palette = {
  slots: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9"],
  other: "#898781",
  symbol: "#5c5f66",
  retired: "#3a3d44",
  edge: "#3b414b",
  edgeFaint: "#262a31",
  dim: "#262a31",
  pulse: "#8098ff",
  dangling: "#d03b3b",
  detached: "#ec835a",
  edgeless: "#fab219",
  label: "#e2e5ea",
  surface: "#171a1f",
};

export function paletteFor(dark: boolean): Palette {
  return dark ? DARK : LIGHT;
}

const TYPE_ORDER = ["fact", "decision", "entity", "howto", "task", "checkpoint", "event_note"];

export interface LegendItem {
  key: string;
  label: string;
  color: string;
  count: number;
}

export interface NodeAttrs {
  x: number;
  y: number;
  size: number;
  color: string;
  label: string;
  kind: GraphNode["kind"];
  invalidated: boolean;
}

export interface EdgeAttrs {
  size: number;
  color: string;
  relation: string;
  index: number;
  pull: number;
}

export type MemoryGraph = Graph<NodeAttrs, EdgeAttrs>;

function categoryOf(node: GraphNode, colorBy: ColorBy): string {
  return colorBy === "type" ? node.type : (node.project ?? "(none)");
}

// Types take a fixed order; projects the seven largest by live nodes, so the toggles, which
// add only retired nodes and symbols, never repaint them.
function slotsFor(nodes: GraphNode[], colorBy: ColorBy): Map<string, number> {
  if (colorBy === "type") return new Map(TYPE_ORDER.map((key, i) => [key, i]));

  const sizes = new Map<string, number>();
  for (const node of nodes) {
    if (node.kind === "symbol" || node.invalidated || node.project === null) continue;
    sizes.set(node.project, (sizes.get(node.project) ?? 0) + 1);
  }
  const keys = [...sizes].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([key]) => key);

  return new Map(keys.slice(0, 7).map((key, i) => [key, i]));
}

export function colorOf(
  node: GraphNode,
  colorBy: ColorBy,
  palette: Palette,
  slots: Map<string, number>,
): string {
  if (node.kind === "symbol") return palette.symbol;
  if (node.invalidated) return palette.retired;

  const slot = slots.get(categoryOf(node, colorBy));

  return slot === undefined ? palette.other : (palette.slots[slot] ?? palette.other);
}

export function legendOf(
  snapshot: GraphSnapshot,
  colorBy: ColorBy,
  palette: Palette,
): LegendItem[] {
  const slots = slotsFor(snapshot.nodes, colorBy);
  const counts = new Map<string, number>();
  let other = 0;
  let symbols = 0;
  let retired = 0;

  for (const node of snapshot.nodes) {
    if (node.kind === "symbol") symbols += 1;
    else if (node.invalidated) retired += 1;
    else if (slots.has(categoryOf(node, colorBy))) {
      const key = categoryOf(node, colorBy);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    } else other += 1;
  }

  const items: LegendItem[] = [...slots]
    .filter(([key]) => counts.has(key))
    .map(([key, slot]) => ({
      key,
      label: key.replace("_", " "),
      color: palette.slots[slot] ?? palette.other,
      count: counts.get(key) ?? 0,
    }));

  if (other) items.push({ key: "(other)", label: "other", color: palette.other, count: other });
  if (retired) {
    items.push({ key: "(retired)", label: "retired", color: palette.retired, count: retired });
  }
  if (symbols)
    items.push({ key: "(symbol)", label: "code symbol", color: palette.symbol, count: symbols });

  return items;
}

// A stable start per id, so a reload settles into roughly the same picture.
function seeded(id: string): [number, number] {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const a = ((h >>> 0) % 10_000) / 10_000;
  const b = ((Math.imul(h, 2654435761) >>> 0) % 10_000) / 10_000;
  const r = 100 * Math.sqrt(a);

  return [r * Math.cos(2 * Math.PI * b), r * Math.sin(2 * Math.PI * b)];
}

function sizeOf(degree: number, kind: GraphNode["kind"]): number {
  const base = kind === "symbol" ? 1.2 : 1.8;

  return Math.min(9, base + Math.sqrt(degree));
}

export function layoutSettings(order: number): ForceAtlas2Settings {
  return {
    barnesHutOptimize: order > 400,
    barnesHutTheta: 0.6,
    scalingRatio: 40,
    gravity: 0.1,
    strongGravityMode: true,
    outboundAttractionDistribution: true,
    slowDown: 2 + 1.5 * Math.log(order),
  };
}

export type Positions = Map<string, [number, number]>;

export function positionsOf(graph: MemoryGraph): Positions {
  const out: Positions = new Map();
  graph.forEachNode((id, a) => out.set(id, [a.x, a.y]));
  return out;
}

// How far nodes moved between two samples, as a share of the picture's diagonal.
export function movement(before: Positions, after: Positions): number {
  let sum = 0;
  let n = 0;
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];

  for (const [id, [x, y]] of after) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    const prev = before.get(id);
    if (!prev) continue;
    sum += Math.hypot(x - prev[0], y - prev[1]);
    n += 1;
  }

  const diagonal = Math.hypot(maxX - minX, maxY - minY);

  return n === 0 || diagonal === 0 ? 0 : sum / n / diagonal;
}

// Brings `graph` to `snapshot` in place, so a running layout keeps every position it has.
export function syncGraph(
  graph: MemoryGraph,
  snapshot: GraphSnapshot,
  colorBy: ColorBy,
  palette: Palette,
): void {
  const slots = slotsFor(snapshot.nodes, colorBy);
  const wanted = new Set(snapshot.nodes.map((n) => n.id));
  const degree = new Map<string, number>();

  for (const edge of snapshot.edges) {
    degree.set(edge.src, (degree.get(edge.src) ?? 0) + 1);
    degree.set(edge.dst, (degree.get(edge.dst) ?? 0) + 1);
  }

  graph.clearEdges();
  graph.forEachNode((id) => {
    if (!wanted.has(id)) graph.dropNode(id);
  });

  const fresh: GraphNode[] = [];

  for (const node of snapshot.nodes) {
    const attrs = {
      size: sizeOf(degree.get(node.id) ?? 0, node.kind),
      color: colorOf(node, colorBy, palette, slots),
      label: truncate(node.title, 48),
      kind: node.kind,
      invalidated: node.invalidated,
    };

    if (graph.hasNode(node.id)) graph.mergeNodeAttributes(node.id, attrs);
    else {
      const [x, y] = seeded(node.id);
      graph.addNode(node.id, { ...attrs, x, y });
      fresh.push(node);
    }
  }

  snapshot.edges.forEach((edge, index) => {
    graph.addDirectedEdgeWithKey(String(index), edge.src, edge.dst, {
      size: 0.4 + 0.6 * Math.max(0, Math.min(1, edge.weight)),
      color: edge.type === "similar_to" ? palette.edgeFaint : palette.edge,
      relation: edge.type,
      index,
      pull: edge.type === "similar_to" ? 0.5 : 1,
    });
  });

  // A node that arrives into a settled picture starts beside a neighbour, not at random.
  for (const node of fresh) {
    const anchor = graph.neighbors(node.id).find((n) => !fresh.some((f) => f.id === n));
    if (anchor === undefined) continue;
    const [dx, dy] = seeded(node.id);
    graph.mergeNodeAttributes(node.id, {
      x: graph.getNodeAttribute(anchor, "x") + dx / 20,
      y: graph.getNodeAttribute(anchor, "y") + dy / 20,
    });
  }
}

export function newGraph(): MemoryGraph {
  return new Graph<NodeAttrs, EdgeAttrs>({ type: "directed", multi: true, allowSelfLoops: true });
}
