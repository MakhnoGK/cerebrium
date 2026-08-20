import { inject } from "tsyringe";
import { HintsService } from "@/application/services";
import { APPLY_CANDIDATE, type ApplyCandidate } from "@/application/use-cases";
import { metadata } from "@/presentation/mcp/tools/consolidate-apply/metadata";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";

type Schema = (typeof metadata)["schema"];

@tool()
export class ConsolidateApplyTool implements McpTool<Schema, unknown> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    @inject(APPLY_CANDIDATE) private readonly apply: ApplyCandidate,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<unknown> {
    const hints = await this.hints.getSessionHints(args.session_id);
    const resolved = await this.apply.invoke({
      session_id: args.session_id,
      id: args.id,
      decision: args.decision,
      override: args.override,
      collapse: args.collapse,
    });

    const out: Record<string, unknown> = { ok: true, ...resolved };

    if (hints.length) out.hints = hints;

    return out;
  }
}
