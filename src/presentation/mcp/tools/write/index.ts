import { inject } from "tsyringe";
import {
  EMBEDDING_PROVIDER_TOKEN,
  EmbeddingRole,
  type EmbeddingProvider,
} from "@/domain/ports/embedding-provider";
import {
  ConsolidationService,
  EmbeddingService,
  HintsService,
  NodeService,
} from "@/application/services";
import { deriveSummary, Envelope } from "@/db/repo";
import { SearchRepo } from "@/db/repositories";
import { chunkContent } from "@/core/chunk";
import { toFtsMatch } from "@/core/fts";
import { MemoryKind, Posture } from "@/core/vocab";
import { McpTool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { metadata } from "@/presentation/mcp/tools/write/metadata";
import {
  ConsolidationPostureConfig,
  ConsolidationThresholdsConfig,
  RetrievalConfig,
} from "@/infrastructure/config";

const DEDUP_CANDIDATES = 5;

// The decision band is ~0.92-0.95 wide, so two decimals would quantise away the
// distinction the score exists to report.
const SCORE_PRECISION = 1000;

interface SimilarExisting {
  id: string;
  title: string;
  summary: string;
  score: number;
  confidence: "high" | "moderate";
  suggestion: string;
}

type Candidate = Omit<SimilarExisting, "confidence">;

type ToolResponse = Envelope & {
  similar_existing?: SimilarExisting[];
  reconcile?: unknown;
  hints?: string[];
  context_notes?: string[];
};

@tool()
export class WriteTool implements McpTool<(typeof metadata)["schema"], ToolResponse> {
  constructor(
    private readonly hintsService: HintsService,
    private readonly embeddingsService: EmbeddingService,
    private readonly nodeService: NodeService,
    private readonly consolidationService: ConsolidationService,
    private readonly search: SearchRepo,
    // TODO: Move to service ?
    @inject(EMBEDDING_PROVIDER_TOKEN) private readonly embeddings: EmbeddingProvider,

    private readonly posture: ConsolidationPostureConfig,
    private readonly retrieval: RetrievalConfig,
    private readonly thresholds: ConsolidationThresholdsConfig,
  ) {}

  public getMetadata = () => metadata;

  public async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<ToolResponse> {
    const project = args.project ?? null;

    if (
      args.event_from !== undefined &&
      args.event_to !== undefined &&
      args.event_to < args.event_from
    ) {
      throw new Error(
        "`event_to` precedes `event_from`; a fact cannot stop being true before it started.",
      );
    }

    const envelope = await this.nodeService.createNode({
      project,
      title: args.title,
      content: args.content,
      type: args.type,
      memory_kind: args.memory_kind,
      session_id: args.session_id,
      links: args.links,
      event_from: args.event_from,
      event_to: args.event_to,
    });

    // When a duplicate is found and a judging provider is configured, sharpen the advisory
    // hint into a specific action. Never blocks, never applies — the agent decides.
    const similar =
      args.memory_kind === MemoryKind.SEMANTIC ? await this.dedupProbe(args, envelope) : [];

    const shouldReconcile = similar.length && this.posture.reconcile !== Posture.OFF;
    const reconcile = shouldReconcile
      ? await this.consolidationService.reconcile({
          similar,
          project,
          draft: { type: args.type, title: args.title, content: args.content },
        })
      : null;

    const hints = await this.hintsService.getUnknownSessionHints(args.session_id, project);
    const notes = this.embeddingsService.getEmbeddingNotes();

    if (similar.length) {
      notes.unshift(
        `Possible duplicate of ${similar[0]!.id} — if same fact, invalidate one with superseded_by.`,
      );
    }

    return {
      ...envelope,
      ...(similar.length ? { similar_existing: similar } : {}),
      ...(notes.length ? { context_notes: notes } : {}),
      ...(hints.length ? { hints } : {}),
      ...(reconcile ? { reconcile } : {}),
    };
  }

  public describeEvent(args: ToolArgs<(typeof metadata)["schema"]>, result: ToolResponse) {
    return { node_id: result.id, detail: { type: args.type, kind: args.memory_kind } };
  }

  // Cheap hybrid probe with the new title + first chunk. Prefers vector cosine; when
  // nothing is embedded yet (or the provider is down), it falls back to lexical
  // Jaccard over the FTS candidates, so it never blocks and never throws.
  private async dedupProbe(
    args: ToolArgs<(typeof metadata)["schema"]>,
    envelope: Envelope,
  ): Promise<SimilarExisting[]> {
    try {
      const firstChunk = chunkContent("probe", args.content)[0]?.text ?? args.content;
      const probe = `${args.title}\n${firstChunk}`;
      const opts = {
        project: args.project,
        kinds: ["semantic"],
        history: false,
        cap: DEDUP_CANDIDATES,
      };

      let scored: Candidate[] = [];
      const [qvec] = await this.embeddings.embed([probe], EmbeddingRole.QUERY);

      if (qvec) {
        scored = this.search.vectorSearch(qvec, opts).map((r) => ({
          id: r.id,
          title: r.title,
          summary: deriveSummary(r.content),
          score: 1 - r.distance, // cosine similarity
          suggestion: "consider update or link + invalidate instead",
        }));
      }

      // Jaccard and cosine are different scales, so the fallback carries its own gate:
      // a paraphrased duplicate scores ~0.18 lexically, where a cosine gate would be ~0.93.
      let threshold = this.retrieval.dedupThreshold;

      if (!scored.length) {
        threshold = this.retrieval.lexicalDedupThreshold;

        const match = toFtsMatch(probe);

        if (match) {
          const probeTokens = tokenSet(probe);

          scored = this.search
            .search({
              match,
              project: args.project,
              kinds: ["semantic"],
              history: false,
              cap: DEDUP_CANDIDATES,
            })
            .rows.map((r) => ({
              id: r.id,
              title: r.title,
              summary: deriveSummary(r.content),
              score: jaccard(probeTokens, tokenSet(`${r.title} ${r.content}`)),
              suggestion: "consider update or link + invalidate instead",
            }));
        }
      }

      return scored
        .filter((c) => c.score >= threshold && c.id !== envelope.id)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((c) => ({
          ...c,
          score: Math.round(c.score * SCORE_PRECISION) / SCORE_PRECISION,
          confidence: c.score >= this.thresholds.mergeSim ? "high" : "moderate",
        }));
    } catch {
      return []; // dedup is advisory; a probe failure must never block the writing
    }
  }
}

function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;

  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;

  return inter / (a.size + b.size - inter);
}
