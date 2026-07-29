import { z } from "zod";
import { ConsolidationKind } from "@/core/vocab";
import { ToolName } from "@/presentation/mcp/tools/contracts";

export const metadata = {
  name: ToolName.CONSOLIDATE_SUGGEST,

  description:
    "List pending consolidation candidates the background sweep has queued for review (the `suggest`-posture " +
    "behaviors). Each is an envelope: id, kind (distill | merge | link | prune), detection score, member node ids, " +
    "canonical id (merge survivor / link target) when set, and a pre-generated proposal when a generation provider " +
    "produced one (else null — you author it at apply time). A proposal carries {title,summary,body} plus the " +
    "provider's `recommendation` ('apply'|'reject') and a one-line `reason` judging whether the records are truly the " +
    "same thing worth consolidating — candidates judged 'reject' are auto-dismissed and never listed here. Review " +
    "these, then commit or dismiss each with `consolidate_apply`. Returns an empty list when nothing is queued.",

  schema: {
    session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
    kind: z
      .nativeEnum(ConsolidationKind)
      .optional()
      .describe("Filter to one kind: distill | merge | link | prune. Omit for all pending."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe("Max candidates (default 20).")
      .optional(),
  },
};
