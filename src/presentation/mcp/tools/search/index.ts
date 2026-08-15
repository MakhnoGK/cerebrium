import { inject } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import {
  EMBEDDING_PROVIDER_TOKEN,
  EmbeddingRole,
  type EmbeddingProvider,
} from "@/domain/ports/embedding-provider";
import { EmbeddingService, HintsService } from "@/application/services";
import type { EnrichedRow, Envelope, SearchRow, VectorRow } from "@/db/repo";
import { summaryIsRedundant, toEnvelope } from "@/db/repo";
import { EdgesRepo, SearchRepo } from "@/db/repositories";
import { toFtsMatch } from "@/core/fts";
import { EdgeType, MemoryKind } from "@/core/vocab";
import { McpTool, tool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { metadata } from "@/presentation/mcp/tools/search/metadata";
import { RetrievalConfig } from "@/infrastructure/config";

// Candidate ceiling before JS re-rank. Episodic decay only lowers scores, so the
// final top-N is contained in the top bm25 candidates. A fixed 100-cap
// scan; raise or paginate if a project ever holds enough matching nodes to notice.
const CANDIDATE_CAP = 100;
const DECAY_DAYS = 14;
const USE_SATURATION = 20; // fetches at which the importance prior reaches its ceiling

// Hybrid retrieval constants.
const RRF_K = 60; // RRF damping; 1/(60+rank)
const FUSE_CAP = 40; // top-N from each branch fed into fusion
const PPR_DEPTH = 2; // hops of subgraph pulled around the query-matched nodes
const PPR_ITERS = 20; // power-iteration ceiling; converges well before this at our scale
const PPR_EPSILON = 1e-6; // L1 delta at which iteration stops early
const BEST_CHUNK_CHARS = 120;

// Edge-type conductance for PPR diffusion: how much rank flows along an edge of this type,
// multiplied by the edge's own stored weight. `supersedes` is absent, so a superseded node
// is never reachable this way. Code structure (`calls`/`defines`/`imports`) is absent too —
// 255k structural edges would swamp the diffusion, and `code_lookup` serves them directly;
// `documents` is what keeps the prose↔code join traversable.
const EDGE_WEIGHTS: Record<string, number> = {
  derived_from: 0.5,
  documents: 0.7,
  references: 0.7,
  relates_to: 0.5,
  similar_to: 0.3,
};

const TRAVERSABLE = Object.keys(EDGE_WEIGHTS);

type Row = SearchRow | VectorRow | EnrichedRow;
type Schema = (typeof metadata)["schema"];

interface Entry {
  row: Row;
  score: number;
  matched: "text" | "vector" | "both" | "graph";
  best_chunk?: string;
  section?: string;
  via?: { node: string; edge: string };
}

// A near-duplicate that gave up its slot to the result carrying it. Still addressable —
// `get` it by id like any other node.
export interface Duplicate {
  id: string;
  title: string;
  score: number;
  // Set when a reviewed `duplicate_of` edge decided this, not the similarity gate.
  recorded?: true;
}

interface Selection {
  entry: Entry;
  duplicates: Duplicate[];
}

// A result is an envelope plus why it surfaced. `summary` is optional because it is dropped
// when `best_chunk` already carries the same text (see `summaryIsRedundant`).
export type SearchResult = Omit<Envelope, "summary"> & {
  summary?: string;
  matched?: "text" | "vector" | "both" | "graph";
  best_chunk?: string;
  section?: string;
  via?: { node: string; edge: string };
  duplicates?: Duplicate[];
};

interface ToolResponse {
  results: SearchResult[];
  total_matches: number;
  hints?: string[];
  context_notes?: string[];
}

// Telemetry for the `events` row, carried out of `invoke` on a symbol key: symbols are
// invisible to JSON.stringify, so this never reaches the agent or costs it tokens.
// `query` + `ids` make the row the retrieval-outcome log: joined against the ids a later
// `get` fetched, they are the implicit relevance signal. `matched` runs parallel to `ids`,
// so an ignored result can be attributed to the retrieval path that produced it.
// `reranked` is present only on the rerank-eligible path — StatsRepo reads a present key as
// "eligible" and a 1 as "reranked".
const AUDIT = Symbol("search.audit");

interface SearchAudit {
  mode: string;
  query: string;
  results: number;
  ids: string[];
  matched: Entry["matched"][];
  folded: { id: string; into: string; score: number; recorded?: true }[];
}

type AuditedResponse = ToolResponse & { [AUDIT]?: SearchAudit };

@tool()
export class SearchTool implements McpTool<Schema, AuditedResponse> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    private readonly embeddings: EmbeddingService,
    private readonly searchRepo: SearchRepo,
    private readonly edges: EdgesRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
    @inject(EMBEDDING_PROVIDER_TOKEN) private readonly provider: EmbeddingProvider,

    private readonly retrieval: RetrievalConfig,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<AuditedResponse> {
    const hints = await this.hints.getSessionHints(args.session_id);
    const history = args.history ?? false;
    const mode = args.mode ?? "hybrid";
    const penalty = this.wantsSymbols(args) ? 1 : this.retrieval.symbolWeight;
    const match = toFtsMatch(args.query);

    if (!match) {
      const empty: AuditedResponse = { results: [], total_matches: 0 };
      if (hints.length) empty.hints = hints;
      empty[AUDIT] = { mode, query: args.query, results: 0, ids: [], matched: [], folded: [] };
      return empty;
    }

    if (mode === "text") {
      return this.textSearch(args, match, history, penalty, hints);
    }

    // ---- candidate generation (branches independent; either may be empty) ----
    let ftsRows: SearchRow[] = [];
    let ftsTotal = 0;
    let ftsChunks = new Map<string, { chunk_text: string; chunk_heading: string | null }>();

    if (mode !== "vector") {
      const r = this.searchRepo.search({
        match,
        project: args.project,
        kinds: args.kinds,
        types: args.types,
        history,
        cap: CANDIDATE_CAP,
        asOf: args.as_of,
        validAt: args.valid_at,
      });

      ftsRows = r.rows.slice(0, FUSE_CAP);
      ftsTotal = r.total;
      ftsChunks = this.searchRepo.bestFtsChunksFor(
        ftsRows.map((r) => r.id),
        match,
      );
    }

    let vecRows: VectorRow[] = [];

    try {
      const [qvec] = await this.provider.embed([args.query], EmbeddingRole.QUERY);

      if (qvec) {
        vecRows = this.searchRepo.vectorSearch(qvec, {
          project: args.project,
          kinds: args.kinds,
          types: args.types,
          history,
          cap: FUSE_CAP,
          asOf: args.as_of,
          validAt: args.valid_at,
        });
      }
    } catch {
      // Provider unavailable -> skip the vector branch; FTS still answers (graceful degradation).
    }

    // ---- RRF fusion ----------------------------------------------------------
    const now = Date.parse(this.clock.now());
    const fused = new Map<
      string,
      {
        row: Row;
        rrf: number;
        text: boolean;
        vector: boolean;
        best_chunk?: string;
        section?: string;
      }
    >();

    ftsRows.forEach((row, i) => {
      const e = fused.get(row.id) ?? { row, rrf: 0, text: false, vector: false };

      e.rrf += 1 / (RRF_K + i + 1);
      e.text = true;

      const chunk = ftsChunks.get(row.id);
      if (chunk && !e.best_chunk) {
        e.best_chunk = chunk.chunk_text.slice(0, BEST_CHUNK_CHARS);
        e.section = chunk.chunk_heading ?? undefined;
      }

      fused.set(row.id, e);
    });

    vecRows.forEach((row, i) => {
      const e = fused.get(row.id) ?? { row, rrf: 0, text: false, vector: false };

      e.rrf += 1 / (RRF_K + i + 1);
      e.vector = true;

      if (!e.best_chunk) {
        e.best_chunk = row.chunk_text.slice(0, BEST_CHUNK_CHARS);
        // Only a headed chunk is worth naming: a preamble match means the node is short
        // or the hit is in its opening, and neither is a section worth narrowing to.
        e.section = row.chunk_heading ?? undefined;
      }

      fused.set(row.id, e);
    });

    const entries = new Map<string, Entry>();

    for (const e of fused.values()) {
      const matched = e.text && e.vector ? "both" : e.vector ? "vector" : "text";

      entries.set(e.row.id, {
        row: e.row,
        score:
          e.rrf *
          memoryFactor(e.row, now, history) *
          symbolFactor(e.row, penalty) *
          strengthFactor(e.row, this.retrieval.useWeight),
        matched,
        best_chunk: e.best_chunk,
        section: e.section,
      });
    }

    const audit: SearchAudit = {
      mode,
      query: args.query,
      results: 0,
      ids: [],
      matched: [],
      folded: [],
    };

    // ---- graph expansion: personalized PageRank (after fusion + rerank) -------
    // Diffusion seeded by the query-matched nodes in proportion to their relevance, over the
    // local subgraph. Multi-hop by construction, and a node backed by several independent
    // seeds outranks one backed by a single strong seed — neither is expressible with fixed
    // 1-hop weights. PPR scores only nodes the query did NOT match directly: direct
    // relevance is left exactly as fusion and rerank computed it.
    if ((args.expand_graph ?? true) && entries.size) {
      for (const entry of this.expandByRank(entries, args.as_of, args.valid_at)) {
        entries.set(entry.row.id, entry);
      }
    }

    // ---- cut + envelopes -----------------------------------------------------
    const ordered = [...entries.values()].sort(byScore);
    const selections = this.selectDiverse(ordered, args.limit);
    const ranked = selections.map((s) => s.entry);

    const results = selections.map(({ entry, duplicates }) => {
      const envelope: SearchResult = {
        ...toEnvelope(entry.row),
        matched: entry.matched,
      };

      if (duplicates.length) {
        envelope.duplicates = duplicates;
      }

      if (entry.best_chunk && (entry.matched === "vector" || entry.matched === "both")) {
        envelope.best_chunk = entry.best_chunk;

        if (entry.section) {
          envelope.section = entry.section;
        }

        if (summaryIsRedundant(envelope.summary ?? "", entry.best_chunk)) {
          delete envelope.summary;
        }
      }

      if (entry.via) {
        envelope.via = entry.via;
      }

      return envelope;
    });

    const notes = this.contextNotes(ranked);

    const out: AuditedResponse = {
      results,
      total_matches: mode === "vector" ? vecRows.length : ftsTotal,
    };

    if (hints.length) out.hints = hints;
    if (notes.length) out.context_notes = notes;

    audit.results = results.length;
    audit.ids = results.map((r) => r.id);
    audit.matched = ranked.map((entry) => entry.matched);
    audit.folded = selections.flatMap(({ entry, duplicates }) =>
      duplicates.map((d) => ({
        id: d.id,
        into: entry.row.id,
        score: d.score,
        ...(d.recorded ? { recorded: true as const } : {}),
      })),
    );
    out[AUDIT] = audit;

    return out;
  }

  public describeEvent(_args: ToolArgs<Schema>, result: AuditedResponse) {
    return { detail: result[AUDIT] ?? null };
  }

  private wantsSymbols(args: ToolArgs<Schema>): boolean {
    if (args.types?.includes("symbol")) {
      return true;
    }

    return args.kinds?.length === 1 && args.kinds[0] === MemoryKind.MIRROR;
  }

  // Phase-1 text-only path, byte-compatible: bm25 normalized by the best match × the
  // memory-kind factor. No RRF, no vectors, no graph, no context_notes.
  private textSearch(
    args: ToolArgs<Schema>,
    match: string,
    history: boolean,
    penalty: number,
    hints: string[],
  ): AuditedResponse {
    const { rows, total } = this.searchRepo.search({
      match,
      project: args.project,
      kinds: args.kinds,
      types: args.types,
      history,
      cap: CANDIDATE_CAP,
      asOf: args.as_of,
      validAt: args.valid_at,
    });

    const now = Date.parse(this.clock.now());
    const best = Math.min(...rows.map((r) => r.bm25));

    const ftsChunks = this.searchRepo.bestFtsChunksFor(
      rows.map((r) => r.id),
      match,
    );

    const ranked = rows
      .map((row) => {
        const normalized = best < 0 ? row.bm25 / best : 1;
        const chunk = ftsChunks.get(row.id);
        const envelope: SearchResult = toEnvelope(row);

        if (chunk) {
          envelope.best_chunk = chunk.chunk_text.slice(0, BEST_CHUNK_CHARS);
          if (chunk.chunk_heading) {
            envelope.section = chunk.chunk_heading;
          }
          if (summaryIsRedundant(envelope.summary ?? "", envelope.best_chunk)) {
            delete envelope.summary;
          }
        }

        return {
          row,
          envelope,
          score:
            normalized *
            memoryFactor(row, now, history) *
            symbolFactor(row, penalty) *
            strengthFactor(row, this.retrieval.useWeight),
        };
      })
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.row.updated.localeCompare(a.row.updated) ||
          a.row.id.localeCompare(b.row.id),
      )
      .slice(0, args.limit)
      .map(({ envelope }) => envelope);

    const out: AuditedResponse = { results: ranked, total_matches: total };

    if (hints.length) out.hints = hints;

    out[AUDIT] = {
      mode: "text",
      query: args.query,
      results: ranked.length,
      ids: ranked.map((r) => r.id),
      matched: ranked.map(() => "text" as const),
      folded: [],
    };

    return out;
  }

  private expandByRank(entries: Map<string, Entry>, asOf?: string, validAt?: string): Entry[] {
    const seeds = [...entries.values()];
    const topScore = Math.max(...seeds.map((s) => s.score));

    if (topScore <= 0) {
      return [];
    }

    const edges = this.edges.subgraphFrom(
      seeds.map((s) => s.row.id),
      { depth: PPR_DEPTH, cap: this.retrieval.pprFrontier, types: TRAVERSABLE, asOf, validAt },
    );

    if (!edges.length) {
      return [];
    }

    const personalization = new Map(seeds.map((s) => [s.row.id, s.score / topScore]));
    const { ranks, contributor } = personalizedPageRank(
      edges,
      personalization,
      this.retrieval.pprAlpha,
    );

    const surfaced = [...ranks].filter(([id]) => !entries.has(id) && ranks.get(id)! > 0);

    if (!surfaced.length) {
      return [];
    }

    // Rank mass is an arbitrary scale, so it is normalized within the surfaced set and spent
    // against a fraction (`MEMORY_GRAPH_BASE`) of the best direct hit — a graph hit can never
    // outrank it.
    const best = Math.max(...surfaced.map(([, r]) => r));
    const rows = new Map(
      this.searchRepo
        .rowsFor(
          surfaced.map(([id]) => id),
          { asOf, validAt },
        )
        .map((r) => [r.id, r]),
    );
    const out: Entry[] = [];

    for (const [id, rank] of surfaced) {
      const row = rows.get(id);
      const via = contributor.get(id);

      if (!row || !via) continue;

      out.push({
        row,
        score: this.retrieval.graphBase * topScore * (rank / best),
        matched: "graph",
        via,
      });
    }

    return out;
  }

  // Maximal Marginal Relevance at the cut: pick greedily by relevance minus the
  // redundancy against what is already selected, so the returned window repeats itself
  // less. Both terms are min-max normalized within this candidate set — unlike the merge
  // gate, nothing here crosses an absolute threshold, and the raw scales (RRF ~0.016 vs
  // cosine confined to 0.85-1.00 by anisotropy) are not comparable. Candidates with no
  // stored vector carry no redundancy, so a not-yet-embedded node is never demoted.
  // Picks the slots and folds near-duplicates into them in one pass. A folded result is
  // still returned — under its representative, with its id — so the cost of a wrong fold
  // is one line further down, not a missing node. Folding is always against a result
  // already selected, never transitive: single-linkage clustering on this corpus chains a
  // third of the store into one component, and this is what stops that.
  private selectDiverse(ordered: Entry[], limit: number): Selection[] {
    const lambda = this.retrieval.mmrLambda;
    const vectors = this.searchRepo.vectorsFor(ordered.map((e) => e.row.id));
    const raw = rawSimilarity(ordered, vectors);
    const ids = ordered.map((e) => e.row.id);
    const protectedPairs = this.edges.supersedesPairs(ids);
    const recordedPairs = this.edges.duplicatePairs(ids);
    // `>= 1` is off, matching `mmrLambda`: a plain `>=` gate would still fire at 1.0,
    // since two identical vectors score exactly 1. It turns the whole fold off, recorded
    // duplicates included.
    const folding = this.retrieval.foldSim < 1;
    const keyOf = (a: number, b: number) => {
      const [x, y] = [ids[a]!, ids[b]!];

      return x < y ? `${x}|${y}` : `${y}|${x}`;
    };
    // A `duplicate_of` edge is a reviewed verdict, so it folds whatever the vectors now
    // say — content drifts, and re-deciding a settled pair on every query would let a
    // revision quietly undo the review. Direction is not honoured: the edge names the
    // pair, the query names which of them is worth the slot.
    const foldable = (a: number, b: number) => {
      if (!folding) return false;

      const key = keyOf(a, b);

      if (protectedPairs.has(key)) return false;

      return recordedPairs.has(key) || raw(a, b) >= this.retrieval.foldSim;
    };

    const useMmr = lambda < 1 && vectors.size > 0;
    const relevance = normalize(ordered.map((e) => e.score));
    const similarity = pairwise(ordered, vectors);
    const redundancy = ordered.map(() => 0);

    const pool = ordered.map((_, index) => index);
    const selected: Selection[] = [];

    while (selected.length < limit && pool.length) {
      let bestSlot = 0;

      if (useMmr) {
        let bestScore = -Infinity;

        pool.forEach((index, slot) => {
          const marginal = lambda * relevance[index]! - (1 - lambda) * redundancy[index]!;

          if (marginal > bestScore) {
            bestScore = marginal;
            bestSlot = slot;
          }
        });
      }

      const [picked] = pool.splice(bestSlot, 1);

      if (picked === undefined) break;

      const duplicates: Duplicate[] = [];

      for (let slot = pool.length - 1; slot >= 0; slot--) {
        const index = pool[slot]!;

        if (!foldable(picked, index)) continue;

        const duplicate: Duplicate = {
          id: ordered[index]!.row.id,
          title: ordered[index]!.row.title,
          score: round3(raw(picked, index)),
        };

        if (recordedPairs.has(keyOf(picked, index))) {
          duplicate.recorded = true;
        }

        duplicates.unshift(duplicate);
        pool.splice(slot, 1);
      }

      selected.push({ entry: ordered[picked]!, duplicates });

      if (useMmr) {
        for (const index of pool) {
          redundancy[index] = Math.max(redundancy[index]!, similarity(picked, index));
        }
      }
    }

    return selected;
  }

  private contextNotes(ranked: Entry[]): string[] {
    const notes = [...this.embeddings.getEmbeddingNotes()];
    const superseded = this.edges.supersededInfo(ranked.map((e) => e.row.id));

    for (const [id, info] of superseded) {
      notes.push(`${id} was superseded by ${info.by} on ${info.at.slice(0, 10)}.`);
    }

    return notes;
  }
}

// Personalized PageRank over the local subgraph: r = (1-alpha)·p + alpha·W·r, with W the
// degree-normalized conductance matrix (edge-type weight × the edge's stored weight).
// Degree normalization is what stops a hub from swallowing the diffusion. Alongside the
// ranks it returns, per node, the single largest contributor — the honest answer to "why
// did this surface", which is what the `via` field reports.
function personalizedPageRank(
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

function byScore(a: Entry, b: Entry): number {
  return (
    b.score - a.score ||
    b.row.updated.localeCompare(a.row.updated) ||
    a.row.id.localeCompare(b.row.id)
  );
}

// Min-max to [0,1]; a set with no spread is all-1 so the term stops discriminating
// instead of amplifying float noise.
function normalize(values: number[]): number[] {
  const min = Math.min(...values);
  const spread = Math.max(...values) - min;

  return values.map((v) => (spread > 0 ? (v - min) / spread : 1));
}

// Candidate-set similarity, min-max normalized over the pairs that exist. A pair where
// either side has no stored vector reads 0 — absent, not dissimilar.
function pairwise(
  entries: Entry[],
  vectors: Map<string, Float32Array>,
): (a: number, b: number) => number {
  const n = entries.length;
  const slots = entries.map((e) => vectors.get(e.row.id));
  const sims = new Float64Array(n * n);
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < n; i++) {
    const left = slots[i];

    if (!left) continue;

    for (let j = i + 1; j < n; j++) {
      const right = slots[j];

      if (!right) continue;

      const sim = cosine(left, right);

      sims[i * n + j] = sim;
      sims[j * n + i] = sim;

      if (sim < min) min = sim;
      if (sim > max) max = sim;
    }
  }

  const spread = max - min;

  return (a, b) => {
    if (!slots[a] || !slots[b]) return 0;

    return spread > 0 ? (sims[a * n + b]! - min) / spread : 0;
  };
}

// Raw cosine, in contrast to `pairwise`, which min-max normalizes within the result set.
// A normalized score is fine for MMR's relative penalty and meaningless against an
// absolute gate — the top pair of any set normalizes to 1.0 however unalike it is.
function rawSimilarity(
  entries: Entry[],
  vectors: Map<string, Float32Array>,
): (a: number, b: number) => number {
  const slots = entries.map((e) => vectors.get(e.row.id));

  return (a, b) => {
    const left = slots[a];
    const right = slots[b];

    return left && right ? cosine(left, right) : 0;
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;

  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;

    dot += x * y;
    na += x * x;
    nb += y * y;
  }

  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

// Episodic relevance decays by DISUSE, not wall-clock age: the clock restarts every time
// an agent actually fetches the node, so a checkpoint that keeps earning its retrieval
// stays reachable while an untouched one still falls away.
function memoryFactor(row: EnrichedRow, now: number, history: boolean): number {
  if (history || row.memory_kind !== MemoryKind.EPISODIC) {
    return 1; // history queries drop episodic decay (superseded nodes included, flagged)
  }

  const touched = Math.max(Date.parse(row.valid_from), Date.parse(row.last_used_at ?? "") || 0);
  const ageDays = Math.max(0, (now - touched) / 86_400_000);

  return Math.exp(-ageDays / DECAY_DAYS);
}

// Importance prior: log-scaled in the number of fetches and hard-capped at 1 + weight, so
// a hot node tilts a close call but can never outrank on popularity alone.
function strengthFactor(row: EnrichedRow, weight: number): number {
  if (weight <= 0 || row.use_count <= 0) {
    return 1;
  }

  return 1 + weight * Math.min(1, Math.log1p(row.use_count) / Math.log1p(USE_SATURATION));
}

function symbolFactor(row: EnrichedRow, penalty: number): number {
  return row.type === "symbol" ? penalty : 1;
}
