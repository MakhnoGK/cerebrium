import { inject } from "tsyringe";
import {
  SESSION_HINTS,
  STATS_SNAPSHOT,
  type SessionHints,
  type StatsSnapshot,
} from "@/application/use-cases";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";
import { metadata } from "@/presentation/mcp/tools/stats/metadata";

type Schema = (typeof metadata)["schema"];

@tool()
export class StatsTool implements McpTool<Schema, unknown> {
  public getMetadata = () => metadata;

  constructor(
    @inject(SESSION_HINTS) private readonly sessionHints: SessionHints,
    @inject(STATS_SNAPSHOT) private readonly snapshot: StatsSnapshot,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<unknown> {
    const stats = await this.snapshot.invoke({});
    const { hints } = args.session_id
      ? await this.sessionHints.invoke({ session_id: args.session_id })
      : { hints: [] };

    return { ...stats, ...(hints.length ? { hints } : {}) };
  }
}
