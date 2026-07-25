import { TypeOf, z, ZodObject } from "zod";
import type { Ctx } from "@/tools/context";
import { touchOrCreate } from "@/tools/context";
import { AbstractTool, ToolName } from "@/tools/contracts";

export class CheckpointTool extends AbstractTool {
  name = ToolName.CHECKPOINT;

  description =
    "Record a session checkpoint before ending a work block. This is the tool to call when you're about to stop: it " +
    "writes an episodic `checkpoint` node (Summary / Decisions / Open threads) and links it to the nodes you touched, so " +
    "the next session's `session_start` can show you exactly where you left off. Returns the checkpoint's envelope.";

  schema = {
    session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
    project: z.string().optional().describe("Project scope; omit for a global checkpoint."),
    summary: z
      .string()
      .min(1)
      .describe("What happened in this work block — the 'where did I leave off' paragraph."),
    decisions: z.array(z.string()).optional().describe("Decisions made, each with its reason."),
    open_threads: z
      .array(z.string())
      .optional()
      .describe("Unfinished work / questions to pick up next time."),
    touched_node_ids: z
      .array(z.string())
      .optional()
      .describe("Ids of nodes this session touched; linked via 'references'."),
  };

  async invoke(ctx: Ctx, args: TypeOf<ZodObject<typeof this.schema>>): Promise<unknown> {
    const hints = touchOrCreate(ctx, args.session_id, args.project ?? null);

    const existing = (args.touched_node_ids ?? []).filter((id) => ctx.repo.nodeExists(id));
    const dropped = (args.touched_node_ids ?? []).filter((id) => !ctx.repo.nodeExists(id));

    if (dropped.length) {
      hints.push(`Ignored ${dropped.length} unknown touched_node_ids: ${dropped.join(", ")}.`);
    }

    const envelope = ctx.repo.createNode({
      memory_kind: "episodic",
      type: "checkpoint",
      title: args.summary.split("\n")[0]!.slice(0, 120),
      content: buildBody(args.summary, args.decisions, args.open_threads),
      project: args.project ?? null,
      session_id: args.session_id,
      ts: ctx.now(),
      links: existing.map((dst) => ({ dst, type: "references" as const })),
    });

    ctx.repo.logEvent(
      "checkpoint",
      args.session_id,
      envelope.id,
      { touched: existing.length },
      ctx.now(),
    );

    return hints.length ? { ...envelope, hints } : envelope;
  }
}

function buildBody(summary: string, decisions?: string[], openThreads?: string[]): string {
  const parts = [`## Summary\n${summary.trim()}`];

  if (decisions?.length) parts.push(`## Decisions\n${decisions.map((d) => `- ${d}`).join("\n")}`);
  if (openThreads?.length)
    parts.push(`## Open threads\n${openThreads.map((t) => `- ${t}`).join("\n")}`);

  return parts.join("\n\n");
}
