import type { z } from "zod";
import type { Repo } from "@/db/repo";
import type { EmbeddingProvider } from "@/embeddings/index";
import type { RerankProvider } from "@/rerank/index";
import type { ConsolidationProvider } from "@/consolidation/index";

export interface Ctx {
  repo: Repo;
  now: () => string;
  workingSetBudget: number;
  provider: EmbeddingProvider;
  reranker: RerankProvider;
  consolidator: ConsolidationProvider;
}

// The validated argument type for a tool, derived directly from its exported Zod
// `schema` shape — so tools don't keep a throwaway `z.object(schema)` value around
// just to `typeof` it.
export type ToolArgs<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;

// Auto-create unknown sessions rather than erroring — agents lose ids and the
// system must stay forgiving. Returns a hint when a session was conjured.
export function touchOrCreate(
  ctx: Ctx,
  sessionId: string,
  project: string | null = null,
): string[] {
  const { created } = ctx.repo.ensureSession(sessionId, project, ctx.now());
  return created
    ? [
        `Unknown session_id — created a new session ${sessionId}. Call session_start next time to get one.`,
      ]
    : [];
}
