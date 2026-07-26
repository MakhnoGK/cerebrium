import type { ToolArgs } from "@/tools/context";
import { touchOrCreate } from "@/tools/context";
import { McpTool } from "@/tools/contracts";
import { Envelope } from "@/core/types";
import { tool } from "@/tools/contracts/tool";
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

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<ToolResponse> {
    const hints = touchOrCreate(this.ctx, args.session_id, args.project ?? null);

    const existing = (args.touched_node_ids ?? []).filter((id) => this.ctx.repo.nodeExists(id));
    const dropped = (args.touched_node_ids ?? []).filter((id) => !this.ctx.repo.nodeExists(id));

    if (dropped.length) {
      hints.push(`Ignored ${dropped.length} unknown touched_node_ids: ${dropped.join(", ")}.`);
    }

    const envelope = this.ctx.repo.createNode({
      memory_kind: "episodic",
      type: "checkpoint",
      title: args.summary.split("\n")[0]!.slice(0, 120),
      content: buildBody(args.summary, args.decisions, args.open_threads),
      project: args.project ?? null,
      session_id: args.session_id,
      ts: this.ctx.now(),
      links: existing.map((dst) => ({ dst, type: "references" as const })),
    });

    this.ctx.repo.logEvent(
      "checkpoint",
      args.session_id,
      envelope.id,
      { touched: existing.length },
      this.ctx.now(),
    );

    return hints.length ? { ...envelope, hints } : envelope;
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
