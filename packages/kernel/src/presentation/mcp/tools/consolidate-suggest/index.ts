import { inject } from "tsyringe";
import {
  SESSION_HINTS,
  SUGGEST_CANDIDATES,
  type SessionHints,
  type SuggestCandidates,
} from "@/application/use-cases";
import { metadata } from "@/presentation/mcp/tools/consolidate-suggest/metadata";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";

type Schema = (typeof metadata)["schema"];

@tool()
export class ConsolidateSuggestTool implements McpTool<Schema, unknown> {
  public getMetadata = () => metadata;

  constructor(
    @inject(SESSION_HINTS) private readonly sessionHints: SessionHints,
    @inject(SUGGEST_CANDIDATES) private readonly suggest: SuggestCandidates,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<unknown> {
    const { hints } = await this.sessionHints.invoke({ session_id: args.session_id });
    const { candidates } = await this.suggest.invoke({ kind: args.kind, limit: args.limit });
    const out: Record<string, unknown> = { candidates };

    if (hints.length) out.hints = hints;

    return out;
  }
}
