import type { ToolArgs } from "@/tools/context";
import { touchOrCreate } from "@/tools/context";
import { McpTool } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { metadata } from "@/tools/consolidate-suggest/metadata";

@tool()
export class ConsolidateSuggestTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const hints = touchOrCreate(this.ctx, args.session_id);
    const candidates = this.ctx.repo.pendingCandidates({ kind: args.kind, limit: args.limit });
    const out: Record<string, unknown> = { candidates };

    this.ctx.repo.logEvent(
      "consolidate_suggest",
      args.session_id,
      null,
      { kind: args.kind ?? null, count: candidates.length },
      this.ctx.now(),
    );

    if (hints.length) out.hints = hints;

    return out;
  }
}
