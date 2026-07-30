import { inject } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import {
  EMBEDDING_PROVIDER_TOKEN,
  EmbeddingRole,
  type EmbeddingProvider,
} from "@/domain/ports/embedding-provider";
import { RERANK_PROVIDER_TOKEN, type RerankProvider } from "@/domain/ports/rerank-provider";
import { EmbeddingService, HintsService } from "@/application/services";
import type { EnrichedRow, Envelope, SearchRow, VectorRow } from "@/db/repo";
import { deriveSummary, toEnvelope } from "@/db/repo";
import { EdgesRepo, SearchRepo } from "@/db/repositories";
import { toFtsMatch } from "@/core/fts";
import { MemoryKind } from "@/core/vocab";
import { McpTool, tool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { metadata } from "@/presentation/mcp/tools/search/metadata";
import { RetrievalConfig } from "@/infrastructure/config";

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
type Schema = (typeof metadata)["schema"];

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

// Telemetry for the `events` row, carried out of `invoke` on a symbol key: symbols are
// invisible to JSON.stringify, so this never reaches the agent or costs it tokens.
// `reranked` is present only on the rerank-eligible path — StatsRepo reads a present
// key as "eligible" and a 1 as "reranked".
const AUDIT = Symbol("search.audit");

interface SearchAudit {
  mode: string;
  results: number;
  reranked?: 0 | 1;
  rerank_candidates?: number;
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
    @inject(RERANK_PROVIDER_TOKEN) private readonly reranker: RerankProvider,

    private readonly retrieval: RetrievalConfig,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<AuditedResponse> {
    const hints = await this.hints.getUnknownSessionHints(args.session_id, null);
    const history = args.history ?? false;
    const mode = args.mode ?? "hybrid";
    const penalty = this.wantsSymbols(args) ? 1 : this.retrieval.symbolWeight;
    const match = toFtsMatch(args.query);

    if (!match) {
      const empty: AuditedResponse = { results: [], total_matches: 0 };
      if (hints.length) empty.hints = hints;
      empty[AUDIT] = { mode, results: 0 };
      return empty;
    }

    if (mode === "text") {
      return this.textSearch(args, match, history, penalty, hints);
    }

    // ---- candidate generation (branches independent; either may be empty) ----
    let ftsRows: SearchRow[] = [];
    let ftsTotal = 0;

    if (mode !== "vector") {
      const r = this.searchRepo.search({
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
      const [qvec] = await this.provider.embed([args.query], EmbeddingRole.QUERY);

      if (qvec) {
        vecRows = this.searchRepo.vectorSearch(qvec, {
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
    const now = Date.parse(this.clock.now());
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
    const audit: SearchAudit = { mode, results: 0 };

    if (entries.size >= MIN_RERANK) {
      audit.reranked = 0;
    }

    if (this.reranker.enabled && entries.size >= MIN_RERANK) {
      const base = [...entries.values()];

      try {
        const scores = await this.reranker.rerank(args.query, base.map(rerankDoc));

        base.forEach((entry, index) => {
          const rel = scores[index];

          if (rel == null || Number.isNaN(rel)) {
            return;
          }

          entry.score =
            rel * memoryFactor(entry.row, now, history) * symbolFactor(entry.row, penalty);
        });

        audit.reranked = 1;
        audit.rerank_candidates = base.length;
      } catch {
        // Reranker unavailable -> keep the RRF ordering (graceful degradation).
      }
    }

    // ---- graph expansion (after fusion + rerank) -----------------------------
    if ((args.expand_graph ?? true) && entries.size) {
      const top = [...entries.values()].sort((a, b) => b.score - a.score).slice(0, EXPAND_PARENTS);
      const parentScore = new Map(top.map((t) => [t.row.id, t.score]));
      const graphAdds = new Map<string, Entry>();

      for (const nb of this.edges.neighborsOf(top.map((t) => t.row.id))) {
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

    const notes = this.contextNotes(ranked);

    const out: AuditedResponse = {
      results,
      total_matches: mode === "vector" ? vecRows.length : ftsTotal,
    };

    if (hints.length) out.hints = hints;
    if (notes.length) out.context_notes = notes;

    audit.results = results.length;
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
    });

    const now = Date.parse(this.clock.now());
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

    const out: AuditedResponse = { results: ranked, total_matches: total };

    if (hints.length) out.hints = hints;

    out[AUDIT] = { mode: "text", results: ranked.length };

    return out;
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

// The short text a candidate is judged on: title + its best snippet (the vector
// best_chunk when present, else the derived summary), capped to a fixed budget. Never
// the full node content — token economy holds through the rerank stage too.
function rerankDoc(e: Entry): string {
  const body = e.best_chunk ?? deriveSummary(e.row.content);

  return `${e.row.title}\n${body}`.slice(0, RERANK_DOC_CHARS);
}

function memoryFactor(row: EnrichedRow, now: number, history: boolean): number {
  if (history || row.memory_kind !== MemoryKind.EPISODIC) {
    return 1; // history queries drop episodic decay (superseded nodes included, flagged)
  }

  const ageDays = Math.max(0, (now - Date.parse(row.valid_from)) / 86_400_000);

  return Math.exp(-ageDays / DECAY_DAYS);
}

function symbolFactor(row: EnrichedRow, penalty: number): number {
  return row.type === "symbol" ? penalty : 1;
}
