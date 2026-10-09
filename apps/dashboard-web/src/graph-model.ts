import Graph from "graphology";
import type { ForceAtlas2Settings } from "graphology-layout-forceatlas2";
import type { GraphEdge, GraphNode, GraphSnapshot } from "@cerebrium/contracts/graph";
import { truncate } from "./format";

export type ColorBy = "type" | "project";

export interface Palette {
  slots: readonly string[];
  other: string;
  symbol: string;
  retired: string;
  edge: string;
  edgeFaint: string;
  edgeFocus: string;
  dimAlpha: number;
  pulse: string;
  dangling: string;
  detached: string;
  edgeless: string;
  label: string;
  labelShadow: string;
  surface: string;
}

const LIGHT: Palette = {
  slots: ["#3a6fc8", "#c4553d", "#15867c", "#a6730f", "#b4467e", "#5c8730", "#7a5bc6"],
  other: "#86837b",
  symbol: "#918e86",
  retired: "#bdbab2",
  edge: "rgba(132, 141, 158, 0.3)",
  edgeFaint: "rgba(132, 141, 158, 0.13)",
  edgeFocus: "rgba(71, 84, 103, 0.85)",
  dimAlpha: 0.16,
  pulse: "#2f55d4",
  dangling: "#c8372f",
  detached: "#c9611f",
  edgeless: "#a77e00",
  label: "#1c1f24",
  labelShadow: "rgba(16, 24, 40, 0.16)",
  surface: "#ffffff",
};

const DARK: Palette = {
  slots: ["#6b9bea", "#e57f63", "#3dbcae", "#d9a43a", "#e27aae", "#8cbb5a", "#a68ef0"],
  other: "#9a978f",
  symbol: "#6f7279",
  retired: "#4a4d54",
  edge: "rgba(150, 160, 178, 0.22)",
  edgeFaint: "rgba(150, 160, 178, 0.08)",
  edgeFocus: "rgba(180, 188, 200, 0.85)",
  dimAlpha: 0.2,
  pulse: "#8aa2ff",
  dangling: "#ef5d53",
  detached: "#ef8a4a",
  edgeless: "#e3b23c",
  label: "#e6e8ec",
  labelShadow: "rgba(0, 0, 0, 0.45)",
  surface: "#23272e",
};

export function paletteFor(dark: boolean): Palette {
  return dark ? DARK : LIGHT;
}

export function fade(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
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
  hub: boolean;
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

const LEAF_DEGREE = 2;
const MIN_SIZE = 1.5;
const LEAF_SIZE = 2.5;
const MAX_SIZE = 20;
const SIZE_GAMMA = 1.5;
const DEGREE_FLOOR = 40;
const SYMBOL_SCALE = 0.8;
const HUB_LABELS = 8;
const HUB_MIN_DEGREE = 4;

export function sizeOf(degree: number, kind: GraphNode["kind"], maxDegree: number): number {
  const reach = Math.log1p(Math.max(maxDegree, DEGREE_FLOOR) - LEAF_DEGREE);
  const size =
    degree <= LEAF_DEGREE
      ? MIN_SIZE + ((LEAF_SIZE - MIN_SIZE) * degree) / LEAF_DEGREE
      : LEAF_SIZE +
        (MAX_SIZE - LEAF_SIZE) * (Math.log1p(degree - LEAF_DEGREE) / reach) ** SIZE_GAMMA;

  return kind === "symbol" ? size * SYMBOL_SCALE : size;
}

// Sigma's line program draws an edge 2 x size px wide.
export function edgeSizeOf(weight: number): number {
  return 0.12 + 0.14 * Math.max(0, Math.min(1, weight));
}

export function layoutSettings(order: number): ForceAtlas2Settings {
  return {
    barnesHutOptimize: order > 400,
    barnesHutTheta: 0.6,
    scalingRatio: 40,
    gravity: 0.05,
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

function rank(edge: GraphEdge): number {
  const authored = edge.provenance === "agent";
  switch (edge.type) {
    case "relates_to":
      return authored ? 6 : 3;
    case "references":
      return authored ? 5 : 3;
    case "derived_from":
    case "supersedes":
    case "documents":
      return 4;
    case "duplicate_of":
      return 1;
    case "similar_to":
      return 0;
    default:
      return 2;
  }
}

// A spanning forest that prefers authored links: the edges the layout pulls along and draws
// solid. Every other edge stays in the picture, faint.
export function backbone(edges: readonly GraphEdge[]): Set<number> {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root) ?? root;
    parent.set(id, root);
    return root;
  };

  const order = edges
    .map((edge, index) => ({ edge, index }))
    .sort(
      (a, b) => rank(b.edge) - rank(a.edge) || b.edge.weight - a.edge.weight || a.index - b.index,
    );
  const spine = new Set<number>();

  for (const { edge, index } of order) {
    const [a, b] = [find(edge.src), find(edge.dst)];
    if (a === b) continue;
    parent.set(a, b);
    spine.add(index);
  }

  return spine;
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

  let maxDegree = 0;
  for (const d of degree.values()) maxDegree = Math.max(maxDegree, d);
  const hubs = new Set(
    snapshot.nodes
      .filter((n) => n.kind !== "symbol" && (degree.get(n.id) ?? 0) >= HUB_MIN_DEGREE)
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id))
      .slice(0, HUB_LABELS)
      .map((n) => n.id),
  );

  graph.clearEdges();
  graph.forEachNode((id) => {
    if (!wanted.has(id)) graph.dropNode(id);
  });

  const fresh: GraphNode[] = [];

  for (const node of snapshot.nodes) {
    const attrs = {
      size: sizeOf(degree.get(node.id) ?? 0, node.kind, maxDegree),
      color: colorOf(node, colorBy, palette, slots),
      label: truncate(node.title, 48),
      kind: node.kind,
      invalidated: node.invalidated,
      hub: hubs.has(node.id),
    };

    if (graph.hasNode(node.id)) graph.mergeNodeAttributes(node.id, attrs);
    else {
      const [x, y] = seeded(node.id);
      graph.addNode(node.id, { ...attrs, x, y });
      fresh.push(node);
    }
  }

  const spine = backbone(snapshot.edges);

  snapshot.edges.forEach((edge, index) => {
    const onSpine = spine.has(index);
    graph.addDirectedEdgeWithKey(String(index), edge.src, edge.dst, {
      size: edgeSizeOf(edge.weight),
      color: onSpine ? palette.edge : palette.edgeFaint,
      relation: edge.type,
      index,
      pull: onSpine ? 1 : 0.05,
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

export type LayoutGraph = Graph<{ x: number; y: number }, { pull: number }>;

export function newLayoutGraph(): LayoutGraph {
  return new Graph({ type: "directed", multi: true, allowSelfLoops: true });
}

const RING_MAX = 3;

// The connected components small enough to sit on the ring: orphans, pairs and triples.
export function ringPieces(graph: MemoryGraph): string[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    parent.set(id, root);
    return root;
  };

  graph.forEachNode((id) => parent.set(id, id));
  graph.forEachEdge((_, __, src, dst) => {
    const [a, b] = [find(src), find(dst)];
    if (a !== b) parent.set(a, b);
  });

  const groups = new Map<string, string[]>();
  graph.forEachNode((id) => {
    const root = find(id);
    const group = groups.get(root);
    if (group) group.push(id);
    else groups.set(root, [id]);
  });

  const small = [...groups.values()].filter((g) => g.length <= RING_MAX);
  if (small.length === groups.size) return [];

  return small
    .map((g) => g.sort())
    .sort((a, b) => b.length - a.length || (a[0] ?? "").localeCompare(b[0] ?? ""));
}

// The physics runs on everything but the ring.
export function syncLayout(
  layout: LayoutGraph,
  graph: MemoryGraph,
  ring: ReadonlySet<string>,
): void {
  layout.clear();
  graph.forEachNode((id, a) => {
    if (!ring.has(id)) layout.addNode(id, { x: a.x, y: a.y });
  });
  graph.forEachEdge((_, a, src, dst) => {
    if (layout.hasNode(src) && layout.hasNode(dst)) layout.addEdge(src, dst, { pull: a.pull });
  });
}

// Copies the layout's positions into the picture and lays the ring around them.
export function follow(graph: MemoryGraph, layout: LayoutGraph, pieces: string[][]): void {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  layout.forEachNode((_, a) => {
    minX = Math.min(minX, a.x);
    maxX = Math.max(maxX, a.x);
    minY = Math.min(minY, a.y);
    maxY = Math.max(maxY, a.y);
  });

  const [cx, cy] = layout.order ? [(minX + maxX) / 2, (minY + maxY) / 2] : [0, 0];
  let radius = 0;
  layout.forEachNode((_, a) => {
    radius = Math.max(radius, Math.hypot(a.x - cx, a.y - cy));
  });
  radius = radius || 100;

  const ring = new Map<string, [number, number]>();
  const r = radius * 1.18;
  pieces.forEach((piece, i) => {
    const angle = (2 * Math.PI * i) / pieces.length - Math.PI / 2;
    const [px, py] = [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
    piece.forEach((id, j) => {
      const spin = (2 * Math.PI * j) / piece.length;
      const d = piece.length > 1 ? radius * 0.015 : 0;
      ring.set(id, [px + d * Math.cos(spin), py + d * Math.sin(spin)]);
    });
  });

  graph.updateEachNodeAttributes(
    (id, a) => {
      const at = layout.hasNode(id) ? layout.getNodeAttributes(id) : null;
      const slot = ring.get(id);
      if (at) {
        a.x = at.x;
        a.y = at.y;
      } else if (slot) {
        [a.x, a.y] = slot;
      }
      return a;
    },
    { attributes: ["x", "y"] },
  );
}
