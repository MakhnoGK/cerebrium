import { inject } from "tsyringe";
import { HintsService } from "@/application/services";
import { RECORD_CHECKPOINT, type RecordCheckpoint } from "@/application/use-cases";
import { Envelope } from "@/core/types";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";
import { metadata } from "./metadata";

type Schema = (typeof metadata)["schema"];
type ToolResponse = (Envelope & { hints: string[] }) | Envelope;

@tool()
export class CheckpointTool implements McpTool<Schema, ToolResponse> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    @inject(RECORD_CHECKPOINT) private readonly checkpoint: RecordCheckpoint,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<ToolResponse> {
    const hints = await this.hints.getSessionHints(args.session_id);
    const { envelope } = await this.checkpoint.invoke({
      session_id: args.session_id,
      title: args.title,
      summary: args.summary,
      decisions: args.decisions,
      open_threads: args.open_threads,
      project: args.project,
      touched_node_ids: args.touched_node_ids,
    });

    return hints.length ? { ...envelope, hints } : envelope;
  }

  public describeEvent(_args: ToolArgs<Schema>, result: ToolResponse) {
    // A fresh checkpoint's only edges are the `references` links to the touched nodes.
    return { node_id: result.id, detail: { touched: result.edges } };
  }
}
