import { ConsolidationRepo } from "@/db/repositories";
import { metadata } from "@/presentation/mcp/tools/consolidate-retry/metadata";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";

@tool()
export class ConsolidateRetryTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  constructor(private readonly consolidation: ConsolidationRepo) {}

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    this.consolidation.clearCandidateProposal(args.id, null);
    this.consolidation.reopenCandidate(args.id);

    return { status: "reopened", id: args.id };
  }
}
