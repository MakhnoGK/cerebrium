import { HintsService } from "@/application/services";
import { NodesRepo } from "@/db/repositories";
import { Envelope } from "@/core/types";
import { EdgeType, MemoryKind } from "@/core/vocab";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";
import { metadata } from "./metadata";

// TODO: Move to a separate file
type ToolResponse =
  | (Envelope & {
      hints: string[];
    })
  | Envelope;

@tool()
export class CheckpointTool implements McpTool<(typeof metadata)["schema"], ToolResponse> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    // TODO: Think how to move to service
    private readonly nodes: NodesRepo,
  ) {}

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<ToolResponse> {
    const hints = await this.hints.getSessionHints(args.session_id);

    const existing = await this.filterAsync(args.touched_node_ids ?? [], (id) =>
      this.nodes.exists(id),
    );
    const dropped = await this.filterAsync(
      args.touched_node_ids ?? [],
      async (id) => !(await this.nodes.exists(id)),
    );

    if (dropped.length) {
      hints.push(`Ignored ${dropped.length} unknown touched_node_ids: ${dropped.join(", ")}.`);
    }

    const envelope = await this.nodes.createNode({
      memory_kind: MemoryKind.EPISODIC,
      type: "checkpoint",
      title: args.summary.split("\n")[0]!.slice(0, 120),
      content: buildBody(args.summary, args.decisions, args.open_threads),
      project: args.project ?? null,
      session_id: args.session_id,
      ts: new Date().toISOString(),
      links: existing.map((dst) => ({ dst, type: EdgeType.REFERENCES })),
    });

    return hints.length ? { ...envelope, hints } : envelope;
  }

  public describeEvent(_args: ToolArgs<(typeof metadata)["schema"]>, result: ToolResponse) {
    // A fresh checkpoint's only edges are the `references` links to the touched nodes.
    return { node_id: result.id, detail: { touched: result.edges } };
  }

  // TODO: Move to helpers
  private async filterAsync<T>(items: T[], callback: (item: T) => Promise<boolean>): Promise<T[]> {
    const result: T[] = [];

    for (const item of items) {
      const callbackResult = await callback(item);

      if (callbackResult) {
        result.push(item);
      }
    }

    return result;
  }
}

function buildBody(summary: string, decisions?: string[], openThreads?: string[]): string {
  const parts = [`## Summary\n${summary.trim()}`];

  if (decisions?.length) {
    parts.push(`## Decisions\n${decisions.map((d) => `- ${d}`).join("\n")}`);
  }

  if (openThreads?.length) {
    parts.push(`## Open threads\n${openThreads.map((t) => `- ${t}`).join("\n")}`);
  }

  return parts.join("\n\n");
}
