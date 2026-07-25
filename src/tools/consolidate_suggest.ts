import { TypeOf, z, ZodObject } from "zod";
import type { Ctx } from "@/tools/context";
import { touchOrCreate } from "@/tools/context";
import { CONSOLIDATION_KINDS } from "@/core/vocab";
import { AbstractTool, ToolName } from "@/tools/contracts";

export class ConsolidateSuggestTool extends AbstractTool {
  name = ToolName.CONSOLIDATE_SUGGEST;

  description =
    "List pending consolidation candidates the background sweep has queued for review (the `suggest`-posture " +
    "behaviors). Each is an envelope: id, kind (distill | merge | link | prune), detection score, member node ids, " +
    "canonical id (merge survivor / link target) when set, and a pre-generated proposal when a generation provider " +
    "produced one (else null — you author it at apply time). A proposal carries {title,summary,body} plus the " +
    "provider's `recommendation` ('apply'|'reject') and a one-line `reason` judging whether the records are truly the " +
    "same thing worth consolidating — candidates judged 'reject' are auto-dismissed and never listed here. Review " +
    "these, then commit or dismiss each with `consolidate_apply`. Returns an empty list when nothing is queued.";

  schema = {
    session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
    kind: z
      .enum(CONSOLIDATION_KINDS)
      .optional()
      .describe("Filter to one kind: distill | merge | link | prune. Omit for all pending."),
    limit: z.number().int().min(1).max(50).default(20).describe("Max candidates (default 20)."),
  };

  protected async invoke(ctx: Ctx, args: TypeOf<ZodObject<typeof this.schema>>): Promise<unknown> {
    const hints = touchOrCreate(ctx, args.session_id);
    const candidates = ctx.repo.pendingCandidates({ kind: args.kind, limit: args.limit });
    const out: Record<string, unknown> = { candidates };

    ctx.repo.logEvent(
      "consolidate_suggest",
      args.session_id,
      null,
      { kind: args.kind ?? null, count: candidates.length },
      ctx.now(),
    );

    if (hints.length) out.hints = hints;

    return out;
  }
}
