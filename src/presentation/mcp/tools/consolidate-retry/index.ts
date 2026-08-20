import { inject } from "tsyringe";
import { RETRY_CANDIDATE, type RetryCandidate } from "@/application/use-cases";
import { metadata } from "@/presentation/mcp/tools/consolidate-retry/metadata";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";

@tool()
export class ConsolidateRetryTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  constructor(@inject(RETRY_CANDIDATE) private readonly retry: RetryCandidate) {}

  invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    return this.retry.invoke({ id: args.id });
  }
}
