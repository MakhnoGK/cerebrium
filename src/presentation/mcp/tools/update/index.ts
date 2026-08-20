import { inject } from "tsyringe";
import { HintsService } from "@/application/services";
import { UPDATE_MEMORY, type UpdateMemory } from "@/application/use-cases";
import { McpTool, tool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { metadata } from "@/presentation/mcp/tools/update/metadata";

type Schema = (typeof metadata)["schema"];

@tool()
export class UpdateTool implements McpTool<Schema, unknown> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    @inject(UPDATE_MEMORY) private readonly update: UpdateMemory,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<unknown> {
    const hints = await this.hints.getSessionHints(args.session_id);
    const { envelope, notes } = await this.update.invoke({
      session_id: args.session_id,
      id: args.id,
      content: args.content,
      title: args.title,
      reason: args.reason,
      event_from: args.event_from,
      event_to: args.event_to,
    });

    return {
      ...envelope,
      ...(notes.length ? { context_notes: notes } : {}),
      ...(hints.length ? { hints } : {}),
    };
  }
}
