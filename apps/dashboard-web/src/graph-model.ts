import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type ForceCollide,
  type ForceLink,
  type ForceManyBody,
  type ForceX,
  type ForceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import Graph from "graphology";
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
  canvas: string;
}

const LIGHT: Palette = {
  slots: ["#7d9cc9", "#c98a7a", "#6aa79f", "#c2a165", "#c286a6", "#8fac72", "#a294cc"],
  other: "#a9a69f",
  symbol: "#b3b0a9",
  retired: "#d3d0c9",
  edge: "#b3b8c0",
  edgeFaint: "#cfd3d8",
  edgeFocus: "#626d7d",
  dimAlpha: 0.16,
  pulse: "#2f55d4",
  dangling: "#c8372f",
  detached: "#c9611f",
  edgeless: "#a77e00",
  label: "#3a3d42",
  canvas: "#fafaf8",
};

const DARK: Palette = {
  slots: ["#7f9fd0", "#cf8f7d", "#6db3aa", "#c7a76a", "#c98cad", "#94b278", "#a89ad4"],
  other: "#86847e",
  symbol: "#62656b",
  retired: "#41444a",
  edge: "#4a4f59",
  edgeFaint: "#353941",
  edgeFocus: "#9ca4af",
  dimAlpha: 0.2,
  pulse: "#8aa2ff",
  dangling: "#ef5d53",
  detached: "#ef8a4a",
  edgeless: "#e3b23c",
  label: "#c9ccd2",
  canvas: "#171a1f",
};

export function paletteFor(dark: boolean): Palette {
  return dark ? DARK : LIGHT;
}

// Sigma's WebGL programs draw translucent colours lighter than the canvas, so blend up front.
export function fade(hex: string, alpha: number, over: string): string {
  const [a, b] = [Number.parseInt(hex.slice(1), 16), Number.parseInt(over.slice(1), 16)];
  const mix = (shift: number) =>
    Math.round(((a >> shift) & 255) * alpha + ((b >> shift) & 255) * (1 - alpha));
  return `rgb(${mix(16)}, ${mix(8)}, ${mix(0)})`;
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

const SYMBOL_SCALE = 0.8;
const HUB_LABELS = 8;
const HUB_MIN_DEGREE = 4;
// Sigma's line program draws an edge 2 x size px wide.
const EDGE_SIZE = 0.5;

export interface Tuning {
  repel: number;
  linkDistance: number;
  collideGap: number;
  gravityX: number;
  gravityY: number;
  nodeScale: number;
  nodeZoom: number;
  labelDensity: number;
  labelFadeFrom: number;
}

export const TUNING: Tuning = {
  repel: -200,
  linkDistance: 20,
  collideGap: 17,
  gravityX: 0.003,
  gravityY: 0.007,
  nodeScale: 0.25,
  nodeZoom: 0.75,
  labelDensity: 0.3,
  labelFadeFrom: 1.2,
};

// The radius before `Tuning.nodeScale`, which the node reducer applies.
export function sizeOf(degree: number, kind: GraphNode["kind"]): number {
  const size = 2 + Math.sqrt(degree);

  return kind === "symbol" ? size * SYMBOL_SCALE : size;
}

export interface SimNode extends SimulationNodeDatum {
  id: string;
  r: number;
}

type SimLink = SimulationLinkDatum<SimNode>;

export type Layout = Simulation<SimNode, SimLink>;

export function newLayout(tuning: Tuning): Layout {
  const layout = forceSimulation<SimNode>()
    .force("charge", forceManyBody<SimNode>())
    .force(
      "link",
      forceLink<SimNode, SimLink>().id((n) => n.id),
    )
    .force("collide", forceCollide<SimNode>().iterations(3))
    .force("x", forceX<SimNode>())
    .force("y", forceY<SimNode>())
    .stop();
  tuneLayout(layout, tuning);

  return layout;
}

export function tuneLayout(layout: Layout, t: Tuning): void {
  layout.force<ForceManyBody<SimNode>>("charge")?.strength(t.repel);
  layout.force<ForceLink<SimNode, SimLink>>("link")?.distance(t.linkDistance);
  layout.force<ForceCollide<SimNode>>("collide")?.radius((n) => n.r * t.nodeScale + t.collideGap);
  layout.force<ForceX<SimNode>>("x")?.strength(t.gravityX);
  layout.force<ForceY<SimNode>>("y")?.strength(t.gravityY);
}

// Keeps the position and velocity of every node the layout already has; true when the shape
// changed.
export function syncLayout(layout: Layout, graph: MemoryGraph): boolean {
  const known = new Map(layout.nodes().map((n) => [n.id, n]));
  const force = layout.force<ForceLink<SimNode, SimLink>>("link");
  const before = force?.links().length ?? 0;
  const nodes = graph.mapNodes((id, a): SimNode => {
    const node = known.get(id) ?? { id, r: a.size, x: a.x, y: a.y };
    node.r = a.size;
    return node;
  });

  const seen = new Set<string>();
  const links: SimLink[] = [];
  graph.forEachEdge((_, __, src, dst) => {
    if (src === dst) return;
    const key = src < dst ? `${src} ${dst}` : `${dst} ${src}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ source: src, target: dst });
  });

  layout.nodes(nodes);
  force?.links(links);

  return (
    nodes.length !== known.size || nodes.some((n) => !known.has(n.id)) || links.length !== before
  );
}

export function follow(graph: MemoryGraph, layout: Layout): void {
  const at = new Map(layout.nodes().map((n) => [n.id, n]));
  graph.updateEachNodeAttributes(
    (id, a) => {
      const node = at.get(id);
      if (node?.x !== undefined && node.y !== undefined) {
        a.x = node.x;
        a.y = node.y;
      }
      return a;
    },
    { attributes: ["x", "y"] },
  );
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

// A spanning forest that prefers authored links: the edges drawn solid. Every other edge stays
// in the picture, faint.
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
      size: sizeOf(degree.get(node.id) ?? 0, node.kind),
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
      size: EDGE_SIZE,
      color: onSpine ? palette.edge : palette.edgeFaint,
      relation: edge.type,
      index,
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
