import { useQuery, useQueryClient } from "@tanstack/react-query";
import FA2Layout from "graphology-layout-forceatlas2/worker";
import { useEffect, useMemo, useRef, useState } from "react";
import Sigma from "sigma";
import type { NodeHoverDrawingFunction } from "sigma/rendering";
import type { EdgeDisplayData, NodeDisplayData } from "sigma/types";
import type { ActivityEntry } from "@cerebrium/contracts/dashboard";
import {
  graphIntegrity,
  type GraphIntegrity,
  type GraphNode,
  type GraphSnapshot,
} from "@cerebrium/contracts/graph";
import { errorMessage, fetchGraph, type ActivityBus } from "../api";
import {
  follow,
  layoutSettings,
  legendOf,
  movement,
  newGraph,
  newLayoutGraph,
  paletteFor,
  positionsOf,
  ringPieces,
  syncGraph,
  syncLayout,
  type ColorBy,
  type EdgeAttrs,
  type MemoryGraph,
  type NodeAttrs,
  type Palette,
} from "../graph-model";
import { Badge, Empty, Mono, Notice, RelTime } from "./common";

export const GRAPH_KEY = ["graph"] as const;

const PULSE_MS = 1_600;
const LAYOUT_CAP_MS = 30_000;
const SAMPLE_MS = 500;
const SETTLED = 0.003;
const SETTLED_SAMPLES = 3;
const REFETCH_DEBOUNCE_MS = 2_000;
const FORCED_LABELS = 12;
const WRITES = new Set([
  "write",
  "update",
  "invalidate",
  "restore",
  "checkpoint",
  "link",
  "consolidate_apply",
  "review_resolve",
]);

interface Pulse {
  start: number;
  strong: boolean;
}

interface View {
  palette: Palette;
  integrity: GraphIntegrity | null;
  integrityOn: boolean;
  danglingTargets: Set<string>;
  focus: string | null;
  focusNeighbors: Set<string>;
  selected: string | null;
  pulses: Map<string, Pulse>;
}

function usePrefersDark(): boolean {
  const query = "(prefers-color-scheme: dark)";
  const [dark, setDark] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return dark;
}

function hoverDrawer(palette: Palette): NodeHoverDrawingFunction<NodeAttrs, EdgeAttrs> {
  return (ctx, data, settings) => {
    const size = settings.labelSize;
    ctx.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
    const label = data.label ?? "";
    const pad = 4;
    const w = label ? ctx.measureText(label).width + 2 * pad : 0;
    const h = size + 2 * pad;
    const r = data.size + 3;

    ctx.fillStyle = palette.surface;
    ctx.shadowColor = "rgb(0 0 0 / 25%)";
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(data.x, data.y, r, 0, Math.PI * 2);
    if (label) ctx.rect(data.x, data.y - h / 2, r + w, h);
    ctx.fill();
    ctx.shadowBlur = 0;

    if (label) {
      ctx.fillStyle = palette.label;
      ctx.fillText(label, data.x + r + pad, data.y + size / 3);
    }
  };
}

function nodeReducer(view: View, graph: MemoryGraph) {
  return (node: string, data: NodeAttrs): Partial<NodeDisplayData> => {
    const res: Partial<NodeDisplayData> = { ...data };
    const { palette, integrity } = view;

    if (view.integrityOn && integrity) {
      if (integrity.edgeless.has(node)) res.color = palette.edgeless;
      else if (integrity.detached.has(node)) res.color = palette.detached;
      else if (view.danglingTargets.has(node)) res.color = palette.dangling;
      else res.color = palette.dim;
    }

    if (view.focus !== null && graph.hasNode(view.focus)) {
      if (node === view.focus || view.focusNeighbors.has(node)) {
        res.forceLabel = node === view.focus || view.focusNeighbors.size <= FORCED_LABELS;
        res.zIndex = 1;
      } else {
        res.color = palette.dim;
        res.label = null;
      }
    }

    if (node === view.selected) res.highlighted = true;

    const pulse = view.pulses.get(node);
    if (pulse) {
      const t = (performance.now() - pulse.start) / PULSE_MS;
      if (t < 1) {
        res.size = data.size * (1 + (pulse.strong ? 1.8 : 0.8) * (1 - t));
        res.color = palette.pulse;
        res.forceLabel = true;
        res.zIndex = 2;
      }
    }

    return res;
  };
}

function edgeReducer(view: View, graph: MemoryGraph) {
  return (edge: string, data: EdgeAttrs): Partial<EdgeDisplayData> => {
    const res: Partial<EdgeDisplayData> = { ...data };
    const { palette, integrity } = view;

    if (view.integrityOn && integrity) {
      if (integrity.dangling.has(data.index)) {
        res.color = palette.dangling;
        res.size = 1.5;
        res.zIndex = 1;
      } else res.color = palette.edgeFaint;
    }

    if (view.focus !== null && graph.hasNode(view.focus)) {
      const [src, dst] = graph.extremities(edge);
      if (src !== view.focus && dst !== view.focus) res.hidden = true;
      else {
        res.size = Math.max(data.size, 1);
        if (!view.integrityOn) res.color = palette.edge;
      }
    }

    return res;
  };
}

interface Neighbor {
  node: GraphNode;
  relation: string;
  out: boolean;
}

function neighborsOf(
  id: string,
  snapshot: GraphSnapshot,
  byId: Map<string, GraphNode>,
): Neighbor[] {
  const out: Neighbor[] = [];
  for (const edge of snapshot.edges) {
    const other = edge.src === id ? edge.dst : edge.dst === id ? edge.src : null;
    const node = other === null ? undefined : byId.get(other);
    if (node) out.push({ node, relation: edge.type, out: edge.src === id });
  }
  return out.sort(
    (a, b) => a.relation.localeCompare(b.relation) || a.node.title.localeCompare(b.node.title),
  );
}

export default function GraphView({
  active,
  activity,
}: {
  active: boolean;
  activity: ActivityBus;
}) {
  const queryClient = useQueryClient();
  const dark = usePrefersDark();
  const palette = paletteFor(dark);
  const [colorBy, setColorBy] = useState<ColorBy>("type");
  const [showRetired, setShowRetired] = useState(false);
  const [showSymbols, setShowSymbols] = useState(false);
  const [integrityOn, setIntegrityOn] = useState(false);
  const [running, setRunning] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<MemoryGraph>(newGraph());
  const sigmaRef = useRef<Sigma<NodeAttrs, EdgeAttrs> | null>(null);
  const layoutGraphRef = useRef(newLayoutGraph());
  const layoutRef = useRef<FA2Layout | null>(null);
  const piecesRef = useRef<string[][]>([]);
  const pendingRef = useRef(new Map<string, boolean>());
  const frameRef = useRef(0);
  const viewRef = useRef<View>({
    palette,
    integrity: null,
    integrityOn: false,
    danglingTargets: new Set(),
    focus: null,
    focusNeighbors: new Set(),
    selected: null,
    pulses: new Map(),
  });

  const query = { invalidated: showRetired, symbols: showSymbols };
  const snapshot = useQuery({
    queryKey: [...GRAPH_KEY, query],
    queryFn: ({ signal }) => fetchGraph(query, signal),
    enabled: active,
    staleTime: 60_000,
    refetchInterval: active ? 120_000 : false,
    placeholderData: (previous) => previous,
  });
  const data = snapshot.data;

  const byId = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n])), [data]);
  const integrity = useMemo(() => (data ? graphIntegrity(data) : null), [data]);
  const legend = useMemo(
    () => (data ? legendOf(data, colorBy, palette) : []),
    [data, colorBy, palette],
  );

  const refresh = () => sigmaRef.current?.refresh();

  function animate() {
    if (frameRef.current) return;
    const step = () => {
      const now = performance.now();
      const { pulses } = viewRef.current;
      const nodes = [...pulses.keys()].filter((id) => graphRef.current.hasNode(id));
      for (const [id, pulse] of pulses) {
        if (now - pulse.start > PULSE_MS) pulses.delete(id);
      }
      try {
        sigmaRef.current?.refresh({ partialGraph: { nodes }, skipIndexation: true });
      } catch {
        refresh();
      }
      frameRef.current = pulses.size ? requestAnimationFrame(step) : 0;
    };
    frameRef.current = requestAnimationFrame(step);
  }

  function setFocus(id: string | null) {
    const graph = graphRef.current;
    viewRef.current.focus = id;
    viewRef.current.focusNeighbors = new Set(
      id !== null && graph.hasNode(id) ? graph.neighbors(id) : [],
    );
    refresh();
  }

  function select(id: string | null, center = false) {
    setSelected(id);
    viewRef.current.selected = id;
    setFocus(id);
    const sigma = sigmaRef.current;
    if (center && id !== null && sigma) {
      const at = sigma.getNodeDisplayData(id);
      if (at) void sigma.getCamera().animate({ x: at.x, y: at.y, ratio: 0.35 }, { duration: 500 });
    }
  }

  useEffect(() => {
    if (!active || sigmaRef.current || !containerRef.current) return;
    const graph = graphRef.current;
    const view = viewRef.current;
    const sigma = new Sigma<NodeAttrs, EdgeAttrs>(graph, containerRef.current, {
      allowInvalidContainer: true,
      defaultEdgeType: "line",
      labelRenderedSizeThreshold: 12,
      labelDensity: 0.6,
      labelFont: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      labelSize: 12,
      labelColor: { color: view.palette.label },
      defaultDrawNodeHover: hoverDrawer(view.palette),
      zIndex: true,
      nodeReducer: nodeReducer(view, graph),
      edgeReducer: edgeReducer(view, graph),
    });
    sigma.on("enterNode", ({ node }) => {
      if (viewRef.current.selected === null) setFocus(node);
    });
    sigma.on("leaveNode", () => {
      if (viewRef.current.selected === null) setFocus(null);
    });
    sigma.on("clickNode", ({ node }) => select(node));
    sigma.on("clickStage", () => select(null));
    sigmaRef.current = sigma;
  }, [active]);

  useEffect(() => {
    const layout = layoutGraphRef.current;
    const onMove = () => follow(graphRef.current, layout, piecesRef.current);
    layout.on("eachNodeAttributesUpdated", onMove);
    return () => {
      layout.off("eachNodeAttributesUpdated", onMove);
    };
  }, []);

  useEffect(
    () => () => {
      cancelAnimationFrame(frameRef.current);
      layoutRef.current?.kill();
      sigmaRef.current?.kill();
    },
    [],
  );

  useEffect(() => {
    viewRef.current.palette = palette;
    const sigma = sigmaRef.current;
    if (!sigma) return;
    sigma.setSetting("labelColor", { color: palette.label });
    sigma.setSetting("defaultDrawNodeHover", hoverDrawer(palette));
  }, [palette]);

  useEffect(() => {
    if (!data) return;
    const graph = graphRef.current;
    const view = viewRef.current;
    syncGraph(graph, data, colorBy, palette);
    const pieces = ringPieces(graph);
    piecesRef.current = pieces;
    syncLayout(layoutGraphRef.current, graph, new Set(pieces.flat()));
    follow(graph, layoutGraphRef.current, pieces);

    view.integrity = integrity;
    view.danglingTargets = new Set(
      [...(integrity?.dangling ?? [])].map((i) => data.edges[i]?.dst ?? ""),
    );
    if (view.focus !== null) setFocus(graph.hasNode(view.focus) ? view.focus : null);
    if (view.selected !== null && !graph.hasNode(view.selected)) select(null);

    const now = performance.now();
    for (const [id, strong] of pendingRef.current) {
      if (graph.hasNode(id)) {
        view.pulses.set(id, { start: now, strong });
        pendingRef.current.delete(id);
      }
    }
    if (view.pulses.size) animate();

    const layoutGraph = layoutGraphRef.current;
    if (!layoutRef.current && layoutGraph.order > 0) {
      layoutRef.current = new FA2Layout(layoutGraph, {
        settings: layoutSettings(layoutGraph.order),
        getEdgeWeight: "pull",
      });
    }
    sigmaRef.current?.refresh();
  }, [data, colorBy, palette, integrity]);

  useEffect(() => {
    const layout = layoutRef.current;
    if (!layout) return;
    const graph = graphRef.current;
    if (!active || !running) {
      layout.stop();
      return;
    }
    layout.start();
    const started = performance.now();
    let last = positionsOf(graph);
    let calm = 0;
    const timer = window.setInterval(() => {
      const now = positionsOf(graph);
      calm = movement(last, now) < SETTLED ? calm + 1 : 0;
      last = now;
      if (calm >= SETTLED_SAMPLES || performance.now() - started > LAYOUT_CAP_MS) {
        setRunning(false);
      }
    }, SAMPLE_MS);
    return () => window.clearInterval(timer);
  }, [active, running, data]);

  useEffect(() => {
    viewRef.current.integrityOn = integrityOn;
    refresh();
  }, [integrityOn]);

  useEffect(() => {
    if (active) sigmaRef.current?.resize(true).refresh();
  }, [active]);

  useEffect(() => {
    let timer: number | undefined;
    const off = activity.on((entry: ActivityEntry) => {
      if (!entry.ok || entry.node_id === null) return;
      const strong = WRITES.has(entry.action);
      if (graphRef.current.hasNode(entry.node_id)) {
        viewRef.current.pulses.set(entry.node_id, { start: performance.now(), strong });
        animate();
      } else if (strong) {
        pendingRef.current.set(entry.node_id, strong);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey: GRAPH_KEY });
        }, REFETCH_DEBOUNCE_MS);
      }
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [activity, queryClient]);

  const node = selected === null ? undefined : byId.get(selected);
  const neighbors = node && data ? neighborsOf(node.id, data, byId) : [];
  const error = snapshot.isError ? errorMessage(snapshot.error) : null;

  return (
    <div className="stack">
      <div className="toolbar">
        <label>
          Color by
          <select value={colorBy} onChange={(e) => setColorBy(e.target.value as ColorBy)}>
            <option value="type">Type</option>
            <option value="project">Project</option>
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={showRetired}
            onChange={(e) => {
              setShowRetired(e.target.checked);
              setRunning(true);
            }}
          />
          Retired nodes
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={showSymbols}
            onChange={(e) => {
              setShowSymbols(e.target.checked);
              setRunning(true);
            }}
          />
          Code symbols
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={integrityOn}
            onChange={(e) => setIntegrityOn(e.target.checked)}
          />
          Integrity
        </label>
        <button
          type="button"
          className={running ? "btn btn-active" : "btn"}
          onClick={() => setRunning((r) => !r)}
          disabled={!data}
        >
          {running ? "Pause layout" : "Run layout"}
        </button>
        <span className="toolbar-count muted">
          {snapshot.isFetching && "Loading… "}
          {data &&
            `${data.nodes.length.toLocaleString()} nodes · ${data.edges.length.toLocaleString()} edges`}
        </span>
      </div>

      {error && <Notice tone={data ? "warn" : "err"}>Cannot load the graph: {error}.</Notice>}

      <div className="graph-layout">
        <div className="graph-canvas" ref={containerRef}>
          {!data && !error && <p className="loading graph-overlay">Loading the graph…</p>}
          {data?.nodes.length === 0 && (
            <div className="graph-overlay">
              <Empty>The store has no nodes yet.</Empty>
            </div>
          )}
        </div>

        <aside className="graph-side">
          {integrityOn && integrity ? (
            <section className="card">
              <header className="card-head">
                <h2>Integrity</h2>
              </header>
              <ul className="graph-legend card-body">
                <LegendRow
                  color={palette.dangling}
                  label="dangling edges"
                  count={integrity.dangling.size}
                />
                <LegendRow
                  color={palette.detached}
                  label="detached islands"
                  count={integrity.detached.size - integrity.edgeless.size}
                />
                <LegendRow
                  color={palette.edgeless}
                  label="edgeless nodes"
                  count={integrity.edgeless.size}
                />
              </ul>
            </section>
          ) : (
            legend.length > 0 && (
              <section className="card">
                <header className="card-head">
                  <h2>{colorBy === "type" ? "Types" : "Projects"}</h2>
                </header>
                <ul className="graph-legend card-body">
                  {legend.map((item) => (
                    <LegendRow
                      key={item.key}
                      color={item.color}
                      label={item.label}
                      count={item.count}
                    />
                  ))}
                </ul>
              </section>
            )
          )}

          {node ? (
            <section className="card">
              <header className="card-head">
                <h2>{node.title}</h2>
                <button type="button" className="link-btn" onClick={() => select(null)}>
                  Close
                </button>
              </header>
              <div className="card-body graph-detail">
                <div className="graph-tags">
                  <Badge tone="info">{node.type.replace("_", " ")}</Badge>
                  <span className="muted">{node.kind}</span>
                  {node.project && <span className="muted">· {node.project}</span>}
                  {node.invalidated && <Badge tone="warn">retired</Badge>}
                  {integrity?.edgeless.has(node.id) && <Badge tone="warn">edgeless</Badge>}
                  {integrity?.detached.has(node.id) && !integrity.edgeless.has(node.id) && (
                    <Badge tone="warn">detached</Badge>
                  )}
                </div>
                {node.summary && (
                  <p className="graph-summary">{node.summary.replace(/\*\*|`/g, "")}</p>
                )}
                <div className="muted graph-meta">
                  <Mono text={node.id} max={30} />
                  {node.updated && (
                    <span>
                      updated <RelTime iso={node.updated} />
                    </span>
                  )}
                </div>
                <h3 className="graph-subhead">
                  {neighbors.length} {neighbors.length === 1 ? "link" : "links"}
                </h3>
                <ul className="graph-neighbors">
                  {neighbors.map((n, i) => (
                    <li key={`${n.node.id}-${n.relation}-${i}`}>
                      <span className="edge-type">
                        {n.out ? "→" : "←"} {n.relation.replace("_", " ")}
                      </span>
                      <button
                        type="button"
                        className={n.node.invalidated ? "link-btn muted" : "link-btn"}
                        onClick={() => select(n.node.id, true)}
                      >
                        {n.node.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ) : (
            data &&
            data.nodes.length > 0 && (
              <p className="muted graph-hint">
                Hover a node to see its neighbourhood, click it for details. Nodes flash as the
                activity stream touches them.
              </p>
            )
          )}
        </aside>
      </div>
    </div>
  );
}

function LegendRow({ color, label, count }: { color: string; label: string; count: number }) {
  return (
    <li>
      <span className="graph-swatch" style={{ background: color }} aria-hidden="true" />
      <span>{label}</span>
      <span className="num muted">{count.toLocaleString()}</span>
    </li>
  );
}
