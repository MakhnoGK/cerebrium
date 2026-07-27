import type { ToolArgs } from "@/tools/context";
import { deriveSummary, Envelope } from "@/db/repo";
import { chunkContent } from "@/core/chunk";
import { toFtsMatch } from "@/core/fts";
import { reconcilePosture } from "@/consolidation/config";
import { McpTool } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { metadata } from "@/tools/write/metadata";
import { HintsService } from "@/tools/services/hints.service";
import { EmbeddingService } from "@/tools/services/embedding.service";
import { NodeService } from "@/tools/services/node.service";
import { ConsolidationService } from "../services/consolidation.service";
import { SearchRepo } from "@/db/repositories";
import { _MemoryKind } from "@/core/vocab";
import { EMBEDDING_PROVIDER_TOKEN, EmbeddingProvider } from "@/embeddings";
import { inject } from "tsyringe";

const DEDUP_CANDIDATES = 5;

interface SimilarExisting {
  id: string;
  title: string;
  summary: string;
  score: number;
  suggestion: string;
}

type ToolResponse = Envelope & {
  similar_existing?: unknown;
  reconcile?: unknown;
  hints?: string[];
  context_notes?: unknown;
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
  ) {}

  public getMetadata = () => metadata;

  public async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<ToolResponse> {
    const project = args.project ?? null;

    const envelope = await this.nodeService.createNode({
      project,
      title: args.title,
      content: args.content,
      type: args.type,
      memory_kind: args.memory_kind,
      session_id: args.session_id,
      links: args.links,
    });

    // TODO: Custom logger
    // this.ctx.repo.logEvent(
    //   "write",
    //   args.session_id,
    //   envelope.id,
    //   { type: args.type, kind },
    //   this.ctx.now(),
    // );

    // When a duplicate is found and a judging provider is configured, sharpen the advisory
    // hint into a specific action. Never blocks, never applies — the agent decides.
    const similar =
      args.memory_kind === _MemoryKind.SEMANTIC ? await this.dedupProbe(args, envelope) : [];

    const shouldReconcile = similar.length && "off" !== reconcilePosture();
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

      let scored: SimilarExisting[] = [];
      const [qvec] = await this.embeddings.embed([probe], "query");

      if (qvec) {
        scored = this.search.vectorSearch(qvec, opts).map((r) => ({
          id: r.id,
          title: r.title,
          summary: deriveSummary(r.content),
          score: 1 - r.distance, // cosine similarity
          suggestion: "consider update or link + invalidate instead",
        }));
      }

      if (!scored.length) {
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

      const threshold = dedupThreshold();

      return scored
        .filter((c) => c.score >= threshold && c.id !== envelope.id)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((c) => ({ ...c, score: Math.round(c.score * 100) / 100 }));
    } catch {
      return []; // dedup is advisory; a probe failure must never block the writing
    }
  }
}

// Read at call time, so it is tunable per-run (and per-test) via env.
function dedupThreshold(): number {
  return Number(process.env.MEMORY_DEDUP_THRESHOLD) || 0.82;
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
