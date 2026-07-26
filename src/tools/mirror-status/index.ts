import { ToolArgs, touchOrCreate } from "@/tools/context";
import { McpTool } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { metadata } from "@/tools/mirror-status/metadata";

@tool()
export class MirrorStatusTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const hints = touchOrCreate(this.ctx, args.session_id);
    const sources = this.ctx.repo.sourceStatus(this.ctx.now(), args.source_id);
    const out: Record<string, unknown> = { sources };

    this.ctx.repo.logEvent(
      "mirror_status",
      args.session_id,
      null,
      { source_id: args.source_id ?? null, count: sources.length },
      this.ctx.now(),
    );

    if (hints.length) out.hints = hints;

    return out;
  }
}
