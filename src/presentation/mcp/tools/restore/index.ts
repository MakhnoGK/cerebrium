import { inject } from "tsyringe";
import { HintsService } from "@/application/services";
import { RESTORE_MEMORY, type RestoreMemory } from "@/application/use-cases";
import { McpTool, tool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { metadata } from "@/presentation/mcp/tools/restore/metadata";

type Schema = (typeof metadata)["schema"];

@tool()
export class RestoreTool implements McpTool<Schema, unknown> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    @inject(RESTORE_MEMORY) private readonly restore: RestoreMemory,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<unknown> {
    const hints = await this.hints.getSessionHints(args.session_id);
    const { envelope } = await this.restore.invoke({ session_id: args.session_id, id: args.id });

    return hints.length ? { ...envelope, hints } : envelope;
  }
}
