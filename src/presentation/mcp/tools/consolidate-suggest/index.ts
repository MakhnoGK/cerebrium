import { HintsService } from "@/application/services";
import { ConsolidationRepo } from "@/db/repositories";
import { metadata } from "@/presentation/mcp/tools/consolidate-suggest/metadata";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";

@tool()
export class ConsolidateSuggestTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    private readonly consolidation: ConsolidationRepo,
  ) {}

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const hints = await this.hints.getUnknownSessionHints(args.session_id, null);
    const candidates = this.consolidation.pendingCandidates({ kind: args.kind, limit: args.limit });
    const out: Record<string, unknown> = { candidates };

    if (hints.length) out.hints = hints;

    return out;
  }
}
