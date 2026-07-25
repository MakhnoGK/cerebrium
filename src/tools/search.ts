import { TypeOf, z, ZodObject } from "zod";
import type { Ctx, ToolArgs } from "@/tools/context";
import { touchOrCreate } from "@/tools/context";
import { toFtsMatch } from "@/core/fts";
import type { EnrichedRow, Envelope, SearchRow, VectorRow } from "@/db/repo";
import { deriveSummary, toEnvelope } from "@/db/repo";
import { embeddingNotes } from "@/tools/notes";
import { MEMORY_KINDS } from "@/core/vocab";
import { AbstractTool, ToolName } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";

// Candidate ceiling before JS re-rank. Episodic decay only lowers scores, so the
// final top-N is contained in the top bm25 candidates. A fixed 100-cap
// scan; raise or paginate if a project ever holds enough matching nodes to notice.
const CANDIDATE_CAP = 100;
const DECAY_DAYS = 14;

// Hybrid retrieval constants.
const RRF_K = 60; // RRF damping; 1/(60+rank)
const FUSE_CAP = 40; // top-N from each branch fed into fusion
const EXPAND_PARENTS = 5; // top fused nodes whose neighbors we pull
const GRAPH_BASE = 0.3; // graph-surfaced score = 0.3 × parent_score × edge_weight
const BEST_CHUNK_CHARS = 120;

// Reranker (optional, env-gated, default off — see createReranker). Runs over the
// fused base hits before graph expansion; replaces the RRF relevance core with a
// cross-encoder score. Kept small for interactive latency.
const RERANK_DOC_CHARS = 400; // per-candidate text budget handed to the reranker
const MIN_RERANK = 2; // fewer fused candidates than this -> nothing to reorder

// Edge-type weights for 1-hop expansion. `supersedes` is 0: a superseded node
// must never be surfaced this way.
const EDGE_WEIGHTS: Record<string, number> = {
  supersedes: 0,
  derived_from: 0.5,
  documents: 0.7,
  references: 0.7,
  relates_to: 0.5,
  similar_to: 0.3,
};

type Row = SearchRow | VectorRow | EnrichedRow;

interface Entry {
  row: Row;
  score: number;
  matched: "text" | "vector" | "both" | "graph";
  best_chunk?: string;
  via?: { node: string; edge: string };
}

interface ToolResponse {
  results: Envelope[];
  total_matches: number;
  hints?: string[];
  context_notes?: string[];
}

@tool()
export class SearchTool extends AbstractTool {
  name = ToolName.SEARCH;

  description =
    "Search memory. Returns compact envelopes only (never full content; call `get` with the ids you want). Default " +
    "mode blends full-text (bm25) and semantic vector similarity via Reciprocal Rank Fusion, then the memory model: " +
    "semantic facts rank steadily, episodic records decay with age, invalidated nodes are hidden unless `history:true`. " +
    "Each result carries `matched` ('text'|'vector'|'both'|'graph'); vector hits include a `best_chunk` snippet (often " +
    "enough to judge relevance without a `get`); graph-expanded neighbors carry `via:{node,edge}` showing why they " +
    "surfaced. Use `mode:'text'` for the cheapest exact Phase-1 behavior. When the " +
    "`MEMORY_RERANK` reranker is enabled, a local cross-encoder rescoring sharpens the " +
    "fused hits' precision before graph expansion — it is off by default, never applies " +
    "to graph neighbors, and never changes which fields a result returns. Code `symbol` mirrors are " +
    "down-weighted as direct hits so authored and external-mirror knowledge ranks first; ask for them " +
    "explicitly (`types:['symbol']` or `kinds:['mirror']`) to rank them normally. ALWAYS search before writing.";

  schema = {
    session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
    query: z
      .string()
      .describe(
        "Free text; treated as plain terms (quotes = phrase). FTS operators are neutralized.",
      ),
    project: z.string().optional().describe("Restrict to one project; omit to search across all."),
    kinds: z
      .array(z.enum(MEMORY_KINDS))
      .optional()
      .describe("Filter by memory_kind, e.g. ['semantic']."),
    types: z
      .array(z.string())
      .optional()
      .describe("Filter by node type, e.g. ['decision','fact']."),
    history: z
      .boolean()
      .optional()
      .describe(
        "Include invalidated/superseded nodes and drop episodic time-decay — for 'what did we try before'.",
      ),
    mode: z
      .enum(["hybrid", "text", "vector"])
      .optional()
      .describe(
        "hybrid (default): fuse text + vector. 'text': FTS only (fastest). 'vector': semantic only.",
      ),
    expand_graph: z
      .boolean()
      .optional()
      .describe(
        "Also surface 1-hop neighbors of top hits (default true); each carries a `via` edge. Ignored in 'text' mode.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(25)
      .default(10)
      .describe("Max results (default 10, max 25)."),
  };

  async invoke(args: TypeOf<ZodObject<typeof this.schema>>): Promise<ToolResponse> {
    const hints = touchOrCreate(this.ctx, args.session_id);
    const history = args.history ?? false;
    const mode = args.mode ?? "hybrid";
    const penalty = this.wantsSymbols(args) ? 1 : symbolWeight();
    const match = toFtsMatch(args.query);

    if (!match) {
      this.ctx.repo.logEvent(
        "search",
        args.session_id,
        null,
        { query: args.query, empty: true },
        this.ctx.now(),
      );

      const empty: ToolResponse = { results: [], total_matches: 0 };

      if (hints.length) {
        empty.hints = hints;
      }

      return empty;
    }

    if (mode === "text") {
      return this.textSearch(this.ctx, args, match, history, penalty, hints);
    }

    // ---- candidate generation (branches independent; either may be empty) ----
    let ftsRows: SearchRow[] = [];
    let ftsTotal = 0;

    if (mode !== "vector") {
      const r = this.ctx.repo.search({
        match,
        project: args.project,
        kinds: args.kinds,
        types: args.types,
        history,
        cap: CANDIDATE_CAP,
      });

      ftsRows = r.rows.slice(0, FUSE_CAP);
      ftsTotal = r.total;
    }

    let vecRows: VectorRow[] = [];

    try {
      const [qvec] = await this.ctx.provider.embed([args.query], "query");

      if (qvec) {
        vecRows = this.ctx.repo.vectorSearch(qvec, {
          project: args.project,
          kinds: args.kinds,
          types: args.types,
          history,
          cap: FUSE_CAP,
        });
      }
    } catch {
      // Provider unavailable -> skip the vector branch; FTS still answers (graceful degradation).
    }

    // ---- RRF fusion ----------------------------------------------------------
    const now = Date.parse(this.ctx.now());
    const fused = new Map<
      string,
      { row: Row; rrf: number; text: boolean; vector: boolean; best_chunk?: string }
    >();

    ftsRows.forEach((row, i) => {
      const e = fused.get(row.id) ?? { row, rrf: 0, text: false, vector: false };

      e.rrf += 1 / (RRF_K + i + 1);
      e.text = true;

      fused.set(row.id, e);
    });

    vecRows.forEach((row, i) => {
      const e = fused.get(row.id) ?? { row, rrf: 0, text: false, vector: false };

      e.rrf += 1 / (RRF_K + i + 1);
      e.vector = true;

      if (!e.best_chunk) {
        e.best_chunk = row.chunk_text.slice(0, BEST_CHUNK_CHARS);
      }

      fused.set(row.id, e);
    });

    const entries = new Map<string, Entry>();

    for (const e of fused.values()) {
      const matched = e.text && e.vector ? "both" : e.vector ? "vector" : "text";

      entries.set(e.row.id, {
        row: e.row,
        score: e.rrf * memoryFactor(e.row, now, history) * symbolFactor(e.row, penalty),
        matched,
        best_chunk: e.best_chunk,
      });
    }

    // ---- rerank (base hits only, before graph expansion) ---------------------
    // Precision stage on top of RRF recall: a cross-encoder rescoring of the fused
    // text/vector hits. Graph neighbors are deliberately excluded (they earn their
    // place structurally, not by query relevance). Decay stays a post-multiplier, so
    // score = rerankRelevance × memoryFactor, keeping the memory model intact.
    let reranked = false;
    let rerankCandidates = 0;

    if (this.ctx.reranker.enabled && entries.size >= MIN_RERANK) {
      const base = [...entries.values()];

      try {
        const scores = await this.ctx.reranker.rerank(args.query, base.map(rerankDoc));

        base.forEach((entry, index) => {
          const rel = scores[index];

          if (rel == null || Number.isNaN(rel)) {
            return;
          }

          entry.score =
            rel * memoryFactor(entry.row, now, history) * symbolFactor(entry.row, penalty);
        });

        reranked = true;
        rerankCandidates = base.length;
      } catch {
        // Reranker unavailable -> keep the RRF ordering (graceful degradation).
      }
    }

    // ---- graph expansion (after fusion + rerank) -----------------------------
    if ((args.expand_graph ?? true) && entries.size) {
      const top = [...entries.values()].sort((a, b) => b.score - a.score).slice(0, EXPAND_PARENTS);
      const parentScore = new Map(top.map((t) => [t.row.id, t.score]));
      const graphAdds = new Map<string, Entry>();

      for (const nb of this.ctx.repo.neighborsOf(top.map((t) => t.row.id))) {
        if (entries.has(nb.node.id)) {
          continue; // already surfaced directly; don't downgrade to graph
        }

        const weight = EDGE_WEIGHTS[nb.edge] ?? 0;
        const score = GRAPH_BASE * (parentScore.get(nb.parent) ?? 0) * weight;

        if (score <= 0) {
          continue;
        }

        const prev = graphAdds.get(nb.node.id);

        if (!prev || score > prev.score) {
          graphAdds.set(nb.node.id, {
            row: nb.node,
            score,
            matched: "graph",
            via: { node: nb.parent, edge: nb.edge },
          });
        }
      }

      for (const [id, entry] of graphAdds) entries.set(id, entry);
    }

    // ---- cut + envelopes -----------------------------------------------------
    const ranked = [...entries.values()]
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.row.updated.localeCompare(a.row.updated) ||
          a.row.id.localeCompare(b.row.id),
      )
      .slice(0, args.limit);

    const results = ranked.map((entry) => {
      const envelope: Envelope & {
        matched: "text" | "vector" | "graph" | "both";
        best_chunk?: string;
        via?: { node: string; edge: string };
      } = {
        ...toEnvelope(entry.row),
        matched: entry.matched,
      };

      if (entry.best_chunk && (entry.matched === "vector" || entry.matched === "both")) {
        envelope.best_chunk = entry.best_chunk;
      }

      if (entry.via) {
        envelope.via = entry.via;
      }

      return envelope;
    });

    this.ctx.repo.logEvent(
      "search",
      args.session_id,
      null,
      { query: args.query, mode, total: ftsTotal, reranked, rerank_candidates: rerankCandidates },
      this.ctx.now(),
    );

    const notes = contextNotes(this.ctx, ranked);

    const out: ToolResponse = {
      results,
      total_matches: mode === "vector" ? vecRows.length : ftsTotal,
    };

    if (hints.length) {
      out.hints = hints;
    }

    if (notes.length) {
      out.context_notes = notes;
    }

    return out;
  }

  private wantsSymbols(args: ToolArgs<typeof this.schema>): boolean {
    if (args.types?.includes("symbol")) {
      return true;
    }

    return args.kinds?.length === 1 && args.kinds[0] === "mirror";
  }

  // Phase-1 text-only path, byte-compatible: bm25 normalized by the best match × the
  // memory-kind factor. No RRF, no vectors, no graph, no context_notes.
  private textSearch(
    ctx: Ctx,
    args: ToolArgs<typeof this.schema>,
    match: string,
    history: boolean,
    penalty: number,
    hints: string[],
  ) {
    const { rows, total } = ctx.repo.search({
      match,
      project: args.project,
      kinds: args.kinds,
      types: args.types,
      history,
      cap: CANDIDATE_CAP,
    });

    const now = Date.parse(ctx.now());
    const best = Math.min(...rows.map((r) => r.bm25));

    const ranked = rows
      .map((row) => {
        const normalized = best < 0 ? row.bm25 / best : 1;
        return {
          row,
          score: normalized * memoryFactor(row, now, history) * symbolFactor(row, penalty),
        };
      })
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.row.updated.localeCompare(a.row.updated) ||
          a.row.id.localeCompare(b.row.id),
      )
      .slice(0, args.limit)
      .map(({ row }) => toEnvelope(row));

    ctx.repo.logEvent(
      "search",
      args.session_id,
      null,
      { query: args.query, mode: "text", total },
      ctx.now(),
    );

    const out: ToolResponse = { results: ranked, total_matches: total };

    if (hints.length) {
      out.hints = hints;
    }

    return out;
  }
}

function contextNotes(ctx: Ctx, ranked: Entry[]): string[] {
  const notes = [...embeddingNotes(ctx.repo)];
  const superseded = ctx.repo.supersededInfo(ranked.map((e) => e.row.id));

  for (const [id, info] of superseded) {
    notes.push(`${id} was superseded by ${info.by} on ${info.at.slice(0, 10)}.`);
  }

  return notes;
}

// The short text a candidate is judged on: title + its best snippet (the vector
// best_chunk when present, else the derived summary), capped to a fixed budget. Never
// the full node content — token economy holds through the rerank stage too.
function rerankDoc(e: Entry): string {
  const body = e.best_chunk ?? deriveSummary(e.row.content);

  return `${e.row.title}\n${body}`.slice(0, RERANK_DOC_CHARS);
}

function memoryFactor(row: EnrichedRow, now: number, history: boolean): number {
  if (history || row.memory_kind !== "episodic") {
    return 1; // history queries drop episodic decay (superseded nodes included, flagged)
  }

  const ageDays = Math.max(0, (now - Date.parse(row.valid_from)) / 86_400_000);

  return Math.exp(-ageDays / DECAY_DAYS);
}

// Knowledge-first ranking: code `symbol` mirrors are down-weighted as base hits
// so authored + external-mirror knowledge isn't buried under the 100k+ indexed symbols.
// A relevance multiplier, not a filter — symbols still surface, just below equally matched
// knowledge. Not applied to graph neighbors (a note->symbol edge earns its place
// structurally) nor when the caller explicitly asks for symbols (wantsSymbols).
function symbolWeight(): number {
  return Number(process.env.MEMORY_SYMBOL_WEIGHT) || 0.5;
}

function symbolFactor(row: EnrichedRow, penalty: number): number {
  return row.type === "symbol" ? penalty : 1;
}
