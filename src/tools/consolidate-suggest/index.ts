import { ConsolidationRepo } from "@/db/repositories";
import { metadata } from "@/tools/consolidate-suggest/metadata";
import { ToolArgs } from "@/tools/context";
import { McpTool } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { HintsService } from "@/tools/services/hints.service";

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
