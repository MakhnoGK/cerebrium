import { inject } from "tsyringe";
import {
  RESTORE_MEMORY,
  SESSION_HINTS,
  type RestoreMemory,
  type SessionHints,
} from "@/application/use-cases";
import { McpTool, tool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { metadata } from "@/presentation/mcp/tools/restore/metadata";

type Schema = (typeof metadata)["schema"];

@tool()
export class RestoreTool implements McpTool<Schema, unknown> {
  public getMetadata = () => metadata;

  constructor(
    @inject(SESSION_HINTS) private readonly sessionHints: SessionHints,
    @inject(RESTORE_MEMORY) private readonly restore: RestoreMemory,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<unknown> {
    const { hints } = await this.sessionHints.invoke({ session_id: args.session_id });
    const { envelope } = await this.restore.invoke({ session_id: args.session_id, id: args.id });

    return hints.length ? { ...envelope, hints } : envelope;
  }
}
