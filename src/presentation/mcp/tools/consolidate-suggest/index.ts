import { inject } from "tsyringe";
import { HintsService } from "@/application/services";
import { SUGGEST_CANDIDATES, type SuggestCandidates } from "@/application/use-cases";
import { metadata } from "@/presentation/mcp/tools/consolidate-suggest/metadata";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";

type Schema = (typeof metadata)["schema"];

@tool()
export class ConsolidateSuggestTool implements McpTool<Schema, unknown> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    @inject(SUGGEST_CANDIDATES) private readonly suggest: SuggestCandidates,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<unknown> {
    const hints = await this.hints.getSessionHints(args.session_id);
    const { candidates } = await this.suggest.invoke({ kind: args.kind, limit: args.limit });
    const out: Record<string, unknown> = { candidates };

    if (hints.length) out.hints = hints;

    return out;
  }
}
