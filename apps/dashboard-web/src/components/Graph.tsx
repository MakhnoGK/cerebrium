import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import Sigma from "sigma";
import type { NodeHoverDrawingFunction, NodeLabelDrawingFunction } from "sigma/rendering";
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
  fade,
  follow,
  legendOf,
  newGraph,
  newLayout,
  paletteFor,
  syncGraph,
  syncLayout,
  tuneLayout,
  TUNING,
  type ColorBy,
  type EdgeAttrs,
  type Layout,
  type MemoryGraph,
  type NodeAttrs,
  type Palette,
  type SimNode,
  type Tuning,
} from "../graph-model";
import { Badge, Empty, Mono, Notice, RelTime } from "./common";

export const GRAPH_KEY = ["graph"] as const;

const PULSE_MS = 1_600;
const REFETCH_DEBOUNCE_MS = 2_000;
const REHEAT = 0.3;
const DRAG_HEAT = 0.3;
const FORCED_LABELS = 12;
const LEAF_LABEL_DEGREE = 2;
const FOCUS_EDGE_SIZE = 0.6;
const DANGLING_EDGE_SIZE = 0.6;
const LABEL_GAP = 3;
const LABEL_HALO = 3;
const LABEL_FADE_SPAN = 2;
const TUNING_KEY = "cerebrium.graph.tuning";
const SHOW_TUNING = false;
const HOVER_LABEL_SCALE = 1.1;
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
  focusLabels: Set<string>;
  selected: string | null;
  pulses: Map<string, Pulse>;
  tuning: Tuning;
  ratio: number;
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

function labelAlpha(ratio: number, from: number): number {
  return Math.min(1, Math.max(0, (1 / ratio - from) / LABEL_FADE_SPAN));
}

function zoomToSize(tuning: Tuning): (ratio: number) => number {
  return (ratio) => (ratio > 1 ? ratio : ratio ** tuning.nodeZoom);
}

function savedTuning(): Tuning {
  if (!SHOW_TUNING) return TUNING;
  try {
    const raw = localStorage.getItem(TUNING_KEY);
    return raw ? { ...TUNING, ...(JSON.parse(raw) as Partial<Tuning>) } : TUNING;
  } catch {
    return TUNING;
  }
}

function saveTuning(tuning: Tuning): void {
  if (!SHOW_TUNING) return;
  try {
    localStorage.setItem(TUNING_KEY, JSON.stringify(tuning));
  } catch {
    /* storage blocked */
  }
}

function text(
  ctx: CanvasRenderingContext2D,
  palette: Palette,
  data: { x: number; y: number; size: number },
  label: string,
  size: number,
  settings: { labelWeight: string; labelFont: string },
): void {
  const y = data.y - data.size - LABEL_GAP;
  ctx.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.lineJoin = "round";
  ctx.lineWidth = LABEL_HALO;
  ctx.strokeStyle = palette.canvas;
  ctx.strokeText(label, data.x, y);
  ctx.fillStyle = palette.label;
  ctx.fillText(label, data.x, y);
}

function labelDrawer(
  palette: Palette,
  ratio: () => number,
  view: View,
): NodeLabelDrawingFunction<NodeAttrs, EdgeAttrs> {
  return (ctx, data, settings) => {
    if (!data.label) return;
    const alpha = data.forceLabel ? 1 : labelAlpha(ratio(), view.tuning.labelFadeFrom);
    if (alpha === 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    text(ctx, palette, data, data.label, settings.labelSize, settings);
    ctx.restore();
  };
}

function hoverDrawer(palette: Palette): NodeHoverDrawingFunction<NodeAttrs, EdgeAttrs> {
  return (ctx, data, settings) => {
    if (!data.label) return;
    ctx.save();
    text(ctx, palette, data, data.label, settings.labelSize * HOVER_LABEL_SCALE, settings);
    ctx.restore();
  };
}

function nodeReducer(view: View, graph: MemoryGraph) {
  return (node: string, data: NodeAttrs): Partial<NodeDisplayData> => {
    const res: Partial<NodeDisplayData> = { ...data, size: data.size * view.tuning.nodeScale };
    const { palette, integrity } = view;

    if (data.hub) res.forceLabel = true;

    if (view.integrityOn && integrity) {
      if (integrity.edgeless.has(node)) res.color = palette.edgeless;
      else if (integrity.detached.has(node)) res.color = palette.detached;
      else if (view.danglingTargets.has(node)) res.color = palette.dangling;
      else res.color = fade(data.color, palette.dimAlpha, palette.canvas);
    }

    if (view.focus !== null && graph.hasNode(view.focus)) {
      if (node === view.focus || view.focusNeighbors.has(node)) {
        res.forceLabel = node === view.focus || data.hub || view.focusLabels.has(node);
        res.zIndex = 1;
      } else {
        res.color = fade(data.color, palette.dimAlpha, palette.canvas);
        res.forceLabel = false;
        res.label = null;
      }
    }

    if (node === view.selected) res.highlighted = true;

    const pulse = view.pulses.get(node);
    if (pulse) {
      const t = (performance.now() - pulse.start) / PULSE_MS;
      if (t < 1) {
        res.size = (res.size ?? data.size) * (1 + (pulse.strong ? 1.8 : 0.8) * (1 - t));
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
        res.size = DANGLING_EDGE_SIZE;
        res.zIndex = 1;
      } else res.color = palette.edgeFaint;
    }

    if (view.focus !== null && graph.hasNode(view.focus)) {
      const [src, dst] = graph.extremities(edge);
      if (src !== view.focus && dst !== view.focus) res.hidden = true;
      else {
        res.size = Math.max(data.size, FOCUS_EDGE_SIZE);
        res.zIndex = 1;
        if (!view.integrityOn) res.color = palette.edgeFocus;
      }
    }

    // Sigma scales edges by zoomToSizeRatioFunction too, not only nodes.
    res.size = (res.size ?? data.size) * zoomToSize(view.tuning)(view.ratio);

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
  const [tuning, setTuning] = useState(savedTuning);

  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<MemoryGraph>(newGraph());
  const sigmaRef = useRef<Sigma<NodeAttrs, EdgeAttrs> | null>(null);
  const layoutRef = useRef<Layout>(newLayout(tuning));
  const runningRef = useRef(running);
  const dragRef = useRef<SimNode | null>(null);
  const draggedRef = useRef(false);
  const pendingRef = useRef(new Map<string, boolean>());
  const frameRef = useRef(0);
  const viewRef = useRef<View>({
    palette,
    integrity: null,
    integrityOn: false,
    danglingTargets: new Set(),
    focus: null,
    focusNeighbors: new Set(),
    focusLabels: new Set(),
    selected: null,
    pulses: new Map(),
    tuning,
    ratio: 1,
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
    const neighbors = id !== null && graph.hasNode(id) ? graph.neighbors(id) : [];
    viewRef.current.focusNeighbors = new Set(neighbors);
    viewRef.current.focusLabels = new Set(
      neighbors.length <= FORCED_LABELS
        ? neighbors
        : neighbors
            .filter((n) => graph.degree(n) > LEAF_LABEL_DEGREE)
            .sort((a, b) => graph.getNodeAttribute(b, "size") - graph.getNodeAttribute(a, "size"))
            .slice(0, FORCED_LABELS),
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
    const ratio = () => sigmaRef.current?.getCamera().ratio ?? 1;
    const sigma = new Sigma<NodeAttrs, EdgeAttrs>(graph, containerRef.current, {
      allowInvalidContainer: true,
      defaultEdgeType: "line",
      minEdgeThickness: 0.1,
      zoomToSizeRatioFunction: zoomToSize(view.tuning),
      itemSizesReference: "screen",
      labelRenderedSizeThreshold: 0,
      labelDensity: view.tuning.labelDensity,
      labelFont: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      labelSize: 11,
      labelWeight: "400",
      labelColor: { color: view.palette.label },
      defaultDrawNodeLabel: labelDrawer(view.palette, ratio, view),
      defaultDrawNodeHover: hoverDrawer(view.palette),
      zIndex: true,
      nodeReducer: nodeReducer(view, graph),
      edgeReducer: edgeReducer(view, graph),
    });
    sigma.getCamera().on("updated", ({ ratio }) => {
      if (ratio === view.ratio) return;
      view.ratio = ratio;
      sigma.refresh({ skipIndexation: true });
    });
    sigma.on("enterNode", ({ node }) => {
      if (viewRef.current.selected === null && !dragRef.current) setFocus(node);
    });
    sigma.on("leaveNode", () => {
      if (viewRef.current.selected === null && !dragRef.current) setFocus(null);
    });
    sigma.on("clickNode", ({ node }) => {
      if (draggedRef.current) draggedRef.current = false;
      else select(node);
    });
    sigma.on("clickStage", () => {
      if (draggedRef.current) draggedRef.current = false;
      else select(null);
    });

    sigma.on("downNode", ({ node }) => {
      const layout = layoutRef.current;
      const drag = layout.nodes().find((n) => n.id === node);
      if (!drag) return;
      drag.fx = drag.x;
      drag.fy = drag.y;
      dragRef.current = drag;
      draggedRef.current = false;
      if (!sigma.getCustomBBox()) sigma.setCustomBBox(sigma.getBBox());
      if (runningRef.current) layout.alphaTarget(DRAG_HEAT).restart();
    });
    const captor = sigma.getMouseCaptor();
    captor.on("mousemovebody", (e) => {
      const drag = dragRef.current;
      if (!drag) return;
      const at = sigma.viewportToGraph(e);
      drag.fx = at.x;
      drag.fy = at.y;
      draggedRef.current = true;
      if (!runningRef.current) {
        drag.x = at.x;
        drag.y = at.y;
        graph.mergeNodeAttributes(drag.id, at);
      }
      e.preventSigmaDefault();
      e.original.preventDefault();
      e.original.stopPropagation();
    });
    captor.on("mouseup", () => {
      const drag = dragRef.current;
      if (!drag) return;
      drag.fx = null;
      drag.fy = null;
      dragRef.current = null;
      layoutRef.current.alphaTarget(0);
      sigma.setCustomBBox(null);
      if (viewRef.current.selected === null) setFocus(null);
    });
    sigmaRef.current = sigma;
  }, [active]);

  useEffect(() => {
    const layout = layoutRef.current;
    layout.on("tick", () => follow(graphRef.current, layout));
    return () => {
      layout.on("tick", null);
      layout.stop();
    };
  }, []);

  useEffect(
    () => () => {
      cancelAnimationFrame(frameRef.current);
      sigmaRef.current?.kill();
    },
    [],
  );

  useEffect(() => {
    viewRef.current.palette = palette;
    const sigma = sigmaRef.current;
    if (!sigma) return;
    sigma.setSetting("labelColor", { color: palette.label });
    sigma.setSetting(
      "defaultDrawNodeLabel",
      labelDrawer(palette, () => sigma.getCamera().ratio, viewRef.current),
    );
    sigma.setSetting("defaultDrawNodeHover", hoverDrawer(palette));
  }, [palette]);

  useEffect(() => {
    viewRef.current.tuning = tuning;
    saveTuning(tuning);
    const layout = layoutRef.current;
    tuneLayout(layout, tuning);
    if (active && runningRef.current) layout.alpha(Math.max(layout.alpha(), REHEAT)).restart();
    const sigma = sigmaRef.current;
    if (!sigma) return;
    sigma.setSetting("zoomToSizeRatioFunction", zoomToSize(tuning));
    sigma.setSetting("labelDensity", tuning.labelDensity);
  }, [tuning]);

  useEffect(() => {
    if (!data) return;
    const graph = graphRef.current;
    const view = viewRef.current;
    syncGraph(graph, data, colorBy, palette);
    const layout = layoutRef.current;
    if (syncLayout(layout, graph)) layout.alpha(Math.max(layout.alpha(), REHEAT));

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
    sigmaRef.current?.refresh();
  }, [data, colorBy, palette, integrity]);

  useEffect(() => {
    const layout = layoutRef.current;
    runningRef.current = running;
    if (active && running) layout.restart();
    else layout.stop();
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
          onClick={() => {
            const layout = layoutRef.current;
            if (!running) layout.alpha(Math.max(layout.alpha(), REHEAT));
            setRunning(!running);
          }}
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

          {SHOW_TUNING && <TuningPanel tuning={tuning} onChange={setTuning} />}
        </aside>
      </div>
    </div>
  );
}

const SLIDERS: { key: keyof Tuning; label: string; min: number; max: number; step: number }[] = [
  { key: "repel", label: "Repel", min: -600, max: -10, step: 10 },
  { key: "linkDistance", label: "Link distance", min: 10, max: 250, step: 5 },
  { key: "collideGap", label: "Node gap", min: 0, max: 100, step: 1 },
  { key: "gravityX", label: "Gravity X", min: 0, max: 0.1, step: 0.001 },
  { key: "gravityY", label: "Gravity Y", min: 0, max: 0.1, step: 0.001 },
  { key: "nodeScale", label: "Node size", min: 0.1, max: 1.5, step: 0.05 },
  { key: "nodeZoom", label: "Node growth on zoom", min: 0, max: 1, step: 0.05 },
  { key: "labelDensity", label: "Label density", min: 0.05, max: 2, step: 0.05 },
  { key: "labelFadeFrom", label: "Labels appear at zoom", min: 0.5, max: 5, step: 0.1 },
];

function TuningPanel({ tuning, onChange }: { tuning: Tuning; onChange: (t: Tuning) => void }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(JSON.stringify(tuning, null, 2)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    });
  };

  return (
    <section className="card">
      <header className="card-head">
        <h2>Tuning</h2>
        <span className="graph-tune-actions">
          <button type="button" className="link-btn" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" className="link-btn" onClick={() => onChange(TUNING)}>
            Reset
          </button>
        </span>
      </header>
      <div className="card-body graph-tune">
        {SLIDERS.map((s) => (
          <label key={s.key}>
            <span className="graph-tune-head">
              <span>{s.label}</span>
              <span className="num muted">{tuning[s.key]}</span>
            </span>
            <input
              type="range"
              min={s.min}
              max={s.max}
              step={s.step}
              value={tuning[s.key]}
              onChange={(e) => onChange({ ...tuning, [s.key]: Number(e.target.value) })}
            />
          </label>
        ))}
      </div>
    </section>
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
