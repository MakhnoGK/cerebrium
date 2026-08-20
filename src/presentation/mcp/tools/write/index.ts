import { inject } from "tsyringe";
import { HintsService } from "@/application/services";
import { WRITE_MEMORY, type SimilarExisting, type WriteMemory } from "@/application/use-cases";
import { Envelope } from "@/core/types";
import { McpTool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { metadata } from "@/presentation/mcp/tools/write/metadata";

type Schema = (typeof metadata)["schema"];

type ToolResponse = Envelope & {
  similar_existing?: SimilarExisting[];
  reconcile?: unknown;
  hints?: string[];
  context_notes?: string[];
};

@tool()
export class WriteTool implements McpTool<Schema, ToolResponse> {
  constructor(
    private readonly hints: HintsService,
    @inject(WRITE_MEMORY) private readonly write: WriteMemory,
  ) {}

  public getMetadata = () => metadata;

  public async invoke(args: ToolArgs<Schema>): Promise<ToolResponse> {
    const hints = await this.hints.getSessionHints(args.session_id);
    const { envelope, similar_existing, reconcile, notes } = await this.write.invoke({
      session_id: args.session_id,
      memory_kind: args.memory_kind,
      type: args.type,
      title: args.title,
      content: args.content,
      project: args.project ?? null,
      parent_node_id: args.parent_node_id,
      links: args.links,
      event_from: args.event_from,
      event_to: args.event_to,
    });

    return {
      ...envelope,
      ...(similar_existing.length ? { similar_existing } : {}),
      ...(notes.length ? { context_notes: notes } : {}),
      ...(hints.length ? { hints } : {}),
      ...(reconcile ? { reconcile } : {}),
    };
  }

  public describeEvent(args: ToolArgs<Schema>, result: ToolResponse) {
    return { node_id: result.id, detail: { type: args.type, kind: args.memory_kind } };
  }
}
