import { inject } from "tsyringe";
import {
  INVALIDATE_MEMORY,
  SESSION_HINTS,
  type InvalidateMemory,
  type SessionHints,
} from "@/application/use-cases";
import { McpTool, tool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { metadata } from "@/presentation/mcp/tools/invalidate/metadata";

type Schema = (typeof metadata)["schema"];

@tool()
export class InvalidateTool implements McpTool<Schema, unknown> {
  public getMetadata = () => metadata;

  constructor(
    @inject(SESSION_HINTS) private readonly sessionHints: SessionHints,
    @inject(INVALIDATE_MEMORY) private readonly invalidate: InvalidateMemory,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<unknown> {
    const { hints } = await this.sessionHints.invoke({ session_id: args.session_id });
    const { envelope } = await this.invalidate.invoke({
      session_id: args.session_id,
      id: args.id,
      superseded_by: args.superseded_by,
    });

    return hints.length ? { ...envelope, hints } : envelope;
  }
}
