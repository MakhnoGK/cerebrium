import { NodesRepo } from "@/db/repositories";
import { Envelope } from "@/core/types";
import { EdgeType, MemoryKind } from "@/core/vocab";
import type { ToolArgs } from "@/tools/context";
import { McpTool } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { HintsService } from "@/tools/services/hints.service";
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
    const hints = await this.hints.getUnknownSessionHints(args.session_id, args.project ?? null);

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

    // this.ctx.repo.logEvent(
    //   "checkpoint",
    //   args.session_id,
    //   envelope.id,
    //   { touched: existing.length },
    //   this.ctx.now(),
    // );

    return hints.length ? { ...envelope, hints } : envelope;
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
