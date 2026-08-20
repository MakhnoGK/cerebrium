import { inject } from "tsyringe";
import { HintsService } from "@/application/services";
import { INVALIDATE_MEMORY, type InvalidateMemory } from "@/application/use-cases";
import { McpTool, tool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { metadata } from "@/presentation/mcp/tools/invalidate/metadata";

type Schema = (typeof metadata)["schema"];

@tool()
export class InvalidateTool implements McpTool<Schema, unknown> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    @inject(INVALIDATE_MEMORY) private readonly invalidate: InvalidateMemory,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<unknown> {
    const hints = await this.hints.getSessionHints(args.session_id);
    const { envelope } = await this.invalidate.invoke({
      session_id: args.session_id,
      id: args.id,
      superseded_by: args.superseded_by,
    });

    return hints.length ? { ...envelope, hints } : envelope;
  }
}
