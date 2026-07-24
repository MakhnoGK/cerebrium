import { z } from "zod";
import type { Ctx, ToolArgs } from "@/tools/context";
import { touchOrCreate } from "@/tools/context";

export const schema = {
  session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
  source_id: z
    .string()
    .optional()
    .describe("Narrow to one registered source; omit to list them all."),
};

export const description =
  "List the registered external mirror sources for this deployment with their freshness: last sync time, hours " +
  "since, whether each is `stale` (enabled + past its `freshness_hours`, or never synced), and how many live mirror " +
  "nodes it has. Use it to decide what to re-sync; `session_start` also surfaces stale sources automatically. " +
  "Envelopes only — no record content. Returns an empty list when no sources are registered.";

export async function handler(ctx: Ctx, args: ToolArgs<typeof schema>) {
  const hints = touchOrCreate(ctx, args.session_id);

  const sources = ctx.repo.sourceStatus(ctx.now(), args.source_id);

  ctx.repo.logEvent(
    "mirror_status",
    args.session_id,
    null,
    { source_id: args.source_id ?? null, count: sources.length },
    ctx.now(),
  );

  const out: Record<string, unknown> = { sources };
  if (hints.length) out.hints = hints;
  return out;
}
