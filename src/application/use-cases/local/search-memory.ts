import { inject } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import {
  EMBEDDING_PROVIDER_TOKEN,
  EmbeddingRole,
  type EmbeddingProvider,
} from "@/domain/ports/embedding-provider";
import {
  BEST_CHUNK_CHARS,
  byScore,
  CANDIDATE_CAP,
  fuse,
  FUSE_CAP,
  memoryFactor,
  personalizedPageRank,
  PPR_DEPTH,
  selectDiverse,
  strengthFactor,
  symbolFactor,
  TRAVERSABLE,
  type Entry,
} from "@/application/retrieval";
import { EmbeddingService, isRevoked, PrincipalTrustService } from "@/application/services";
import {
  SEARCH_MEMORY,
  useCase,
  type SearchMemory,
  type SearchOutcome,
  type SearchQuery,
  type SearchResult,
} from "@/application/use-cases/contracts";
import { EdgesRepo, SearchRepo } from "@/db/repositories";
import { toFtsMatch } from "@/core/fts";
import { summaryIsRedundant, toEnvelope } from "@/core/types";
import type { SearchRow, VectorRow } from "@/core/types";
import { MemoryKind } from "@/core/vocab";
import { RetrievalConfig } from "@/infrastructure/config";

@useCase(SEARCH_MEMORY)
export class LocalSearchMemory implements SearchMemory {
  constructor(
    private readonly embeddings: EmbeddingService,
    private readonly searchRepo: SearchRepo,
    private readonly edges: EdgesRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
    @inject(EMBEDDING_PROVIDER_TOKEN) private readonly provider: EmbeddingProvider,
    private readonly retrieval: RetrievalConfig,
    private readonly trust: PrincipalTrustService,
  ) {}

  async invoke(args: SearchQuery): Promise<SearchOutcome> {
    const history = args.history ?? false;
    const mode = args.mode ?? "hybrid";
    const penalty = this.wantsSymbols(args) ? 1 : this.retrieval.symbolWeight;
    const match = toFtsMatch(args.query);

    if (!match) {
      return {
        results: [],
        total_matches: 0,
        notes: [],
        audit: { mode, query: args.query, results: 0, ids: [], matched: [], folded: [] },
      };
    }

    if (mode === "text") {
      return this.textSearch(args, match, history, penalty);
    }

    const { ftsRows, ftsTotal, ftsChunks } = this.textCandidates(args, match, history, mode);
    const vecRows = await this.vectorCandidates(args, history);

    const entries = fuse({
      ftsRows,
      ftsChunks,
      vecRows,
      now: Date.parse(this.clock.now()),
      history,
      penalty,
      useWeight: this.retrieval.useWeight,
    });

    this.applyTrust(entries);

    if ((args.expand_graph ?? true) && entries.size) {
      for (const entry of this.expandByRank(entries, args.as_of, args.valid_at)) {
        entries.set(entry.row.id, entry);
      }
    }

    const ordered = [...entries.values()].sort(byScore);
    const selections = selectDiverse(ordered, args.limit, {
      vectors: this.searchRepo.vectorsFor(ordered.map((e) => e.row.id)),
      protectedPairs: this.edges.supersedesPairs(ordered.map((e) => e.row.id)),
      recordedPairs: this.edges.duplicatePairs(ordered.map((e) => e.row.id)),
      foldSim: this.retrieval.foldSim,
      mmrLambda: this.retrieval.mmrLambda,
    });
    const ranked = selections.map((s) => s.entry);

    const results = selections.map(({ entry, duplicates }) => {
      const envelope: SearchResult = { ...toEnvelope(entry.row), matched: entry.matched };

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

    return {
      results,
      total_matches: mode === "vector" ? vecRows.length : ftsTotal,
      notes: this.contextNotes(ranked),
      audit: {
        mode,
        query: args.query,
        results: results.length,
        ids: results.map((r) => r.id),
        matched: ranked.map((entry) => entry.matched),
        folded: selections.flatMap(({ entry, duplicates }) =>
          duplicates.map((d) => ({
            id: d.id,
            into: entry.row.id,
            score: d.score,
            ...(d.recorded ? { recorded: true as const } : {}),
          })),
        ),
      },
    };
  }

  private wantsSymbols(args: SearchQuery): boolean {
    if (args.types?.includes("symbol")) {
      return true;
    }

    return args.kinds?.length === 1 && args.kinds[0] === MemoryKind.MIRROR;
  }

  private textCandidates(
    args: SearchQuery,
    match: string,
    history: boolean,
    mode: string,
  ): {
    ftsRows: SearchRow[];
    ftsTotal: number;
    ftsChunks: ReturnType<SearchRepo["bestFtsChunksFor"]>;
  } {
    if (mode === "vector") {
      return { ftsRows: [], ftsTotal: 0, ftsChunks: new Map() };
    }

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
    const ftsRows = rows.slice(0, FUSE_CAP);

    return {
      ftsRows,
      ftsTotal: total,
      ftsChunks: this.searchRepo.bestFtsChunksFor(
        ftsRows.map((r) => r.id),
        match,
      ),
    };
  }

  private async vectorCandidates(args: SearchQuery, history: boolean): Promise<VectorRow[]> {
    try {
      const qvec =
        args.query_vector ?? (await this.provider.embed([args.query], EmbeddingRole.QUERY))[0];

      if (!qvec) return [];

      return this.searchRepo.vectorSearch(qvec, {
        project: args.project,
        kinds: args.kinds,
        types: args.types,
        history,
        cap: FUSE_CAP,
        asOf: args.as_of,
        validAt: args.valid_at,
      });
    } catch {
      // Provider unavailable -> skip the vector branch; FTS still answers (graceful degradation).
      return [];
    }
  }

  // Phase-1 text-only path, byte-compatible: bm25 normalized by the best match × the
  // memory-kind factor. No RRF, no vectors, no graph, no context_notes.
  private textSearch(
    args: SearchQuery,
    match: string,
    history: boolean,
    penalty: number,
  ): SearchOutcome {
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

    const trust = this.trust.factors(rows.map((r) => r.id));

    const ranked = rows
      .filter((row) => !isRevoked(trust.get(row.id)))
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
            strengthFactor(row, this.retrieval.useWeight) *
            (trust.get(row.id) ?? 1),
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

    return {
      results: ranked,
      total_matches: total,
      notes: [],
      audit: {
        mode: "text",
        query: args.query,
        results: ranked.length,
        ids: ranked.map((r) => r.id),
        matched: ranked.map(() => "text" as const),
        folded: [],
      },
    };
  }

  // The weight multiplies what its principal wrote, and a revoked principal's nodes leave
  // the candidate set outright — before graph expansion, so they cannot seed it either.
  private applyTrust(entries: Map<string, Entry>): void {
    const trust = this.trust.factors([...entries.keys()]);

    for (const [id, factor] of trust) {
      if (isRevoked(factor)) {
        entries.delete(id);

        continue;
      }

      const entry = entries.get(id);

      if (entry) entry.score *= factor;
    }
  }

  // Diffusion seeded by the query-matched nodes in proportion to their relevance, over the
  // local subgraph. Multi-hop by construction, and a node backed by several independent
  // seeds outranks one backed by a single strong seed — neither is expressible with fixed
  // 1-hop weights. PPR scores only nodes the query did NOT match directly: direct
  // relevance is left exactly as fusion computed it.
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

  private contextNotes(ranked: Entry[]): string[] {
    const notes = [...this.embeddings.getEmbeddingNotes()];
    const superseded = this.edges.supersededInfo(ranked.map((e) => e.row.id));

    for (const [id, info] of superseded) {
      notes.push(`${id} was superseded by ${info.by} on ${info.at.slice(0, 10)}.`);
    }

    return notes;
  }
}
