import { TypeOf, z, ZodObject } from "zod";
import { touchOrCreate } from "@/tools/context";
import { AbstractTool, ToolName } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";

@tool()
export class MirrorStatusTool extends AbstractTool {
  name = ToolName.MIRROR_STATUS;

  description =
    "List the registered external mirror sources for this deployment with their freshness: last sync time, hours " +
    "since, whether each is `stale` (enabled + past its `freshness_hours`, or never synced), and how many live mirror " +
    "nodes it has. Use it to decide what to re-sync; `session_start` also surfaces stale sources automatically. " +
    "Envelopes only — no record content. Returns an empty list when no sources are registered.";

  schema = {
    session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
    source_id: z
      .string()
      .optional()
      .describe("Narrow to one registered source; omit to list them all."),
  };

  async invoke(args: TypeOf<ZodObject<typeof this.schema>>): Promise<unknown> {
    const hints = touchOrCreate(this.ctx, args.session_id);
    const sources = this.ctx.repo.sourceStatus(this.ctx.now(), args.source_id);
    const out: Record<string, unknown> = { sources };

    this.ctx.repo.logEvent(
      "mirror_status",
      args.session_id,
      null,
      { source_id: args.source_id ?? null, count: sources.length },
      this.ctx.now(),
    );

    if (hints.length) out.hints = hints;

    return out;
  }
}
