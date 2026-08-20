import { inject } from "tsyringe";
import { HintsService } from "@/application/services";
import { READ_MIRROR_STATUS, type ReadMirrorStatus } from "@/application/use-cases";
import { McpTool, tool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { metadata } from "@/presentation/mcp/tools/mirror-status/metadata";

type Schema = (typeof metadata)["schema"];

@tool()
export class MirrorStatusTool implements McpTool<Schema, unknown> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    @inject(READ_MIRROR_STATUS) private readonly status: ReadMirrorStatus,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<unknown> {
    const hints = await this.hints.getSessionHints(args.session_id);
    const { sources } = await this.status.invoke({ source_id: args.source_id });
    const out: Record<string, unknown> = { sources };

    if (hints.length) out.hints = hints;

    return out;
  }
}
