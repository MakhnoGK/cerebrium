import { inject } from "tsyringe";
import { summaryIsRedundant, toEnvelope } from "@cerebrium/contracts/types";
import type { SearchRow, VectorRow } from "@cerebrium/contracts/types";
import { MemoryKind } from "@cerebrium/contracts/vocab";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import {
  EMBEDDING_PROVIDER_TOKEN,
  EmbeddingRole,
  type EmbeddingProvider,
} from "@/domain/ports/embedding-provider";
import {
  EDGES_REPO_TOKEN,
  SEARCH_REPO_TOKEN,
  STORE_TOKEN,
  type BranchScope,
  type EdgesRepo,
  type SearchRepo,
  type Store,
} from "@/domain/ports/storage";
import {
  BEST_CHUNK_CHARS,
  byScore,
  CANDIDATE_CAP,
  EDGE_WEIGHTS,
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
import {
  CodeReadService,
  EmbeddingService,
  isRevoked,
  PrincipalTrustService,
} from "@/application/services";
import {
  SEARCH_MEMORY,
  useCase,
  type SearchMemory,
  type SearchOutcome,
  type SearchQuery,
  type SearchResult,
} from "@/application/use-cases/contracts";
import { parseTextQuery, type TextQuery } from "@/core/fts";
import { RetrievalConfig } from "@/infrastructure/config";

@useCase(SEARCH_MEMORY)
export class LocalSearchMemory implements SearchMemory {
  constructor(
    private readonly embeddings: EmbeddingService,
    @inject(SEARCH_REPO_TOKEN) private readonly searchRepo: SearchRepo,
    @inject(EDGES_REPO_TOKEN) private readonly edges: EdgesRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
    @inject(EMBEDDING_PROVIDER_TOKEN) private readonly provider: EmbeddingProvider,
    private readonly retrieval: RetrievalConfig,
    private readonly trust: PrincipalTrustService,
    @inject(STORE_TOKEN) private readonly store: Store,
    private readonly code: CodeReadService,
  ) {}

  async invoke(args: SearchQuery): Promise<SearchOutcome> {
    const history = args.history ?? false;
    const activeSince = this.activeSince(args, history);
    const mode = args.mode ?? "hybrid";
    const penalty = this.wantsSymbols(args) ? 1 : this.retrieval.symbolWeight;
    const text = parseTextQuery(args.query);

    if (!text) {
      return {
        results: [],
        total_matches: 0,
        notes: [],
        audit: { mode, query: args.query, results: 0, ids: [], matched: [], folded: [] },
      };
    }

    const code = await this.codeScopes(args);

    if (mode === "text") {
      return await this.textSearch(args, text, history, penalty, code);
    }

    const { ftsRows, ftsTotal, ftsChunks } = await this.textCandidates(
      args,
      text,
      history,
      mode,
      code,
    );
    const vecRows = await this.vectorCandidates(args, history, code);

    const entries = fuse({
      ftsRows,
      ftsChunks,
      vecRows,
      now: Date.parse(this.clock.now()),
      history,
      penalty,
      useWeight: this.retrieval.useWeight,
    });

    await this.applyTrust(entries);

    if ((args.expand_graph ?? true) && entries.size) {
      const expanded = await this.expandByRank(entries, args.as_of, args.valid_at, activeSince);

      for (const entry of [...expanded, ...(await this.expandIntoCode(entries, code))]) {
        entries.set(entry.row.id, entry);
      }
    }

    const ordered = [...entries.values()].sort(byScore);
    const selections = selectDiverse(ordered, args.limit, {
      vectors: await this.searchRepo.vectorsFor(ordered.map((e) => e.row.id)),
      protectedPairs: await this.edges.supersedesPairs(ordered.map((e) => e.row.id)),
      recordedPairs: await this.edges.duplicatePairs(ordered.map((e) => e.row.id)),
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
      notes: [...(await this.contextNotes(ranked)), ...(code?.notes ?? [])],
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

  // The branches this search may read code from, on a store with the per-branch index. The
  // index is searched directly only when symbols are asked for; otherwise code arrives
  // through the notes that link to it.
  private async codeScopes(
    args: SearchQuery,
  ): Promise<{ scopes: BranchScope[]; notes: string[]; direct: boolean } | null> {
    if (!this.store.capabilities.branchCode) return null;

    const direct = this.wantsSymbols(args);

    if (!direct && args.expand_graph === false) return null;

    const resolved = await this.code.scopes({
      ...(args.code_context === undefined ? {} : { code_context: args.code_context }),
      ...(args.as_of === undefined ? {} : { as_of: args.as_of }),
    });

    return { scopes: resolved.scopes, notes: direct ? resolved.notes : [], direct };
  }

  // One hop from the direct hits into the code their notes document, resolved on the
  // branches this search reads. Spent like a graph hit: never above the best direct one.
  private async expandIntoCode(
    entries: Map<string, Entry>,
    code: { scopes: BranchScope[] } | null,
  ): Promise<Entry[]> {
    if (!code?.scopes.length) return [];

    const seeds = [...entries.values()].filter((e) => e.row.type !== "symbol");
    const topScore = Math.max(0, ...seeds.map((s) => s.score));

    if (topScore <= 0) return [];

    const scoreOf = new Map(seeds.map((s) => [s.row.id, s.score]));
    const best = new Map<string, Entry>();

    for (const ref of await this.code.resolveRefs([...scoreOf.keys()], code.scopes)) {
      if (entries.has(ref.row.id)) continue;

      const score =
        this.retrieval.graphBase * (scoreOf.get(ref.src) ?? 0) * (EDGE_WEIGHTS[ref.type] ?? 0.5);
      const held = best.get(ref.row.id);

      if (!held || held.score < score) {
        best.set(ref.row.id, {
          row: ref.row,
          score,
          matched: "graph",
          via: { node: ref.src, edge: ref.type },
        });
      }
    }

    return [...best.values()];
  }

  // A plain search reads live memory; `history`, `as_of` and a search scoped to episodic
  // notes see every one of them.
  private activeSince(args: SearchQuery, history: boolean): string | undefined {
    if (history || args.as_of !== undefined) return undefined;
    if (args.kinds?.length && args.kinds.every((k) => k === MemoryKind.EPISODIC)) {
      return undefined;
    }

    const ttl = this.retrieval.episodicTtlDays;

    return ttl > 0 ? new Date(Date.parse(this.clock.now()) - ttl * 86_400_000).toISOString() : "";
  }

  private wantsSymbols(args: SearchQuery): boolean {
    if (args.types?.includes("symbol")) {
      return true;
    }

    return args.kinds?.length === 1 && args.kinds[0] === MemoryKind.MIRROR;
  }

  private async textCandidates(
    args: SearchQuery,
    text: TextQuery,
    history: boolean,
    mode: string,
    code: { scopes: BranchScope[]; direct: boolean } | null,
  ): Promise<{
    ftsRows: SearchRow[];
    ftsTotal: number;
    ftsChunks: Awaited<ReturnType<SearchRepo["bestFtsChunksFor"]>>;
  }> {
    if (mode === "vector") {
      return { ftsRows: [], ftsTotal: 0, ftsChunks: new Map() };
    }

    const { rows, total } = await this.searchRepo.search({
      text,
      project: args.project,
      kinds: args.kinds,
      types: args.types,
      history,
      cap: CANDIDATE_CAP,
      asOf: args.as_of,
      validAt: args.valid_at,
      activeSince: this.activeSince(args, history),
    });
    const codeRows = await this.codeTextRows(code, text);
    const ftsRows = byTextRank([...rows, ...codeRows]).slice(0, FUSE_CAP);

    return {
      ftsRows,
      ftsTotal: total + codeRows.length,
      ftsChunks: await this.searchRepo.bestFtsChunksFor(
        ftsRows.map((r) => r.id),
        text,
      ),
    };
  }

  private async vectorCandidates(
    args: SearchQuery,
    history: boolean,
    code: { scopes: BranchScope[]; direct: boolean } | null,
  ): Promise<VectorRow[]> {
    try {
      const qvec =
        args.query_vector ?? (await this.provider.embed([args.query], EmbeddingRole.QUERY))[0];

      if (!qvec) return [];

      const rows = await this.searchRepo.vectorSearch(qvec, {
        project: args.project,
        kinds: args.kinds,
        types: args.types,
        history,
        cap: FUSE_CAP,
        asOf: args.as_of,
        validAt: args.valid_at,
        activeSince: this.activeSince(args, history),
      });

      if (!code?.direct || !code.scopes.length) return rows;

      const codeRows = await this.code.vectorRows(code.scopes, qvec, FUSE_CAP);

      return [...rows, ...codeRows]
        .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
        .slice(0, FUSE_CAP);
    } catch {
      // Provider unavailable -> skip the vector branch; FTS still answers (graceful degradation).
      return [];
    }
  }

  // Phase-1 text-only path, byte-compatible: the text rank normalized by the best match × the
  // memory-kind factor. No RRF, no vectors, no graph, no context_notes.
  private async textSearch(
    args: SearchQuery,
    text: TextQuery,
    history: boolean,
    penalty: number,
    code: { scopes: BranchScope[]; notes: string[]; direct: boolean } | null,
  ): Promise<SearchOutcome> {
    const found = await this.searchRepo.search({
      text,
      project: args.project,
      kinds: args.kinds,
      types: args.types,
      history,
      cap: CANDIDATE_CAP,
      asOf: args.as_of,
      validAt: args.valid_at,
      activeSince: this.activeSince(args, history),
    });
    const codeRows = await this.codeTextRows(code, text);
    const rows = byTextRank([...found.rows, ...codeRows]);
    const total = found.total + codeRows.length;

    const now = Date.parse(this.clock.now());
    const best = Math.min(...rows.map((r) => r.text_rank));

    const ftsChunks = await this.searchRepo.bestFtsChunksFor(
      rows.map((r) => r.id),
      text,
    );

    const trust = await this.trust.factors(rows.map((r) => r.id));

    const ranked = rows
      .filter((row) => !isRevoked(trust.get(row.id)))
      .map((row) => {
        const normalized = best < 0 ? row.text_rank / best : 1;
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
      notes: code?.notes ?? [],
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

  private async codeTextRows(
    code: { scopes: BranchScope[]; direct: boolean } | null,
    text: TextQuery,
  ): Promise<SearchRow[]> {
    if (!code?.direct || !code.scopes.length) return [];

    return this.code.textRows(code.scopes, text, CANDIDATE_CAP);
  }

  // The weight multiplies what its principal wrote, and a revoked principal's nodes leave
  // the candidate set outright — before graph expansion, so they cannot seed it either.
  private async applyTrust(entries: Map<string, Entry>): Promise<void> {
    const trust = await this.trust.factors([...entries.keys()]);

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
  private async expandByRank(
    entries: Map<string, Entry>,
    asOf?: string,
    validAt?: string,
    activeSince?: string,
  ): Promise<Entry[]> {
    const seeds = [...entries.values()];
    const topScore = Math.max(...seeds.map((s) => s.score));

    if (topScore <= 0) {
      return [];
    }

    const edges = await this.edges.subgraphFrom(
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
      (
        await this.searchRepo.rowsFor(
          surfaced.map(([id]) => id),
          { asOf, validAt, activeSince },
        )
      ).map((r) => [r.id, r]),
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

  private async contextNotes(ranked: Entry[]): Promise<string[]> {
    const notes = [...(await this.embeddings.getEmbeddingNotes())];
    const superseded = await this.edges.supersededInfo(ranked.map((e) => e.row.id));

    for (const [id, info] of superseded) {
      notes.push(`${id} was superseded by ${info.by} on ${info.at.slice(0, 10)}.`);
    }

    return notes;
  }
}

function byTextRank(rows: SearchRow[]): SearchRow[] {
  return rows.sort((a, b) => a.text_rank - b.text_rank || a.id.localeCompare(b.id));
}
