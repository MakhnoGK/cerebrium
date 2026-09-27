import { z } from "zod";
import { ConsolidationRecommendation } from "@/domain/ports/consolidation-provider";
import { candidateIdSchema, sessionIdSchema, ToolName } from "@/presentation/mcp/tools/contracts";

export const metadata = {
  name: ToolName.CONSOLIDATE_APPLY,

  description:
    "Resolve a pending consolidation candidate from `consolidate_suggest`. reject dismisses it (the exact cluster is " +
    "never re-proposed). apply carries it out: a `link` candidate writes the system similar_to edge between its members; " +
    "a `distill` candidate writes a durable semantic fact from its `override` (or its generated proposal), links it " +
    "`derived_from` each source, and stamps the sources consolidated; a `merge` candidate records a `duplicate_of` " +
    "edge from the duplicate to the canonical node and leaves BOTH live, so retrieval shows one of them and nothing " +
    "is destroyed — pass `collapse:true` to instead rewrite the survivor from `override`/proposal, re-point authored " +
    "edges and supersede the loser, which is lossy and cannot be undone except through `restore`; " +
    "a `prune` candidate soft-invalidates a dead mirror node. Superseded/consolidated/pruned nodes stay " +
    "queryable via history. Application and candidate resolution are atomic; a stale link/merge whose endpoints are " +
    "no longer live is dismissed without mutation. Idempotent per candidate — one already applied or dismissed cannot " +
    "be resolved again.",

  schema: {
    session_id: sessionIdSchema,
    id: candidateIdSchema,
    decision: z
      .nativeEnum(ConsolidationRecommendation)
      .describe("apply: carry out the consolidation. reject: dismiss it (never re-proposed)."),
    override: z
      .object({
        title: z.string().min(1),
        summary: z.string().min(1),
        body: z.string().min(1),
      })
      .optional()
      .describe(
        "When applying a distill/merge candidate: the summary/merged body to write, overriding any generated proposal. Required for distill when the candidate has no proposal (e.g. the manual provider); optional for merge, and only read when `collapse` is set.",
      ),
    collapse: z
      .boolean()
      .optional()
      .describe(
        "Merge candidates only. Default (false) records `duplicate_of` and keeps both nodes. true collapses them into one, invalidating the loser — lossy, so reserve it for when one node genuinely should not exist.",
      ),
  },
};
