import { inject } from "tsyringe";
import {
  READ_MIRROR_STATUS,
  SESSION_HINTS,
  type ReadMirrorStatus,
  type SessionHints,
} from "@/application/use-cases";
import { McpTool, tool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { metadata } from "@/presentation/mcp/tools/mirror-status/metadata";

type Schema = (typeof metadata)["schema"];

@tool()
export class MirrorStatusTool implements McpTool<Schema, unknown> {
  public getMetadata = () => metadata;

  constructor(
    @inject(SESSION_HINTS) private readonly sessionHints: SessionHints,
    @inject(READ_MIRROR_STATUS) private readonly status: ReadMirrorStatus,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<unknown> {
    const { hints } = await this.sessionHints.invoke({ session_id: args.session_id });
    const { sources } = await this.status.invoke({ source_id: args.source_id });
    const out: Record<string, unknown> = { sources };

    if (hints.length) out.hints = hints;

    return out;
  }
}
