import { z } from "zod";
import type { Ctx, ToolArgs } from "@/tools/context";
import { touchOrCreate } from "@/tools/context";

export const schema = {
  session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
  id: z.string().describe("Id of the node to invalidate (soft-delete)."),
  reason: z.string().min(1).describe("Why it's no longer valid — recorded in the activity log."),
  superseded_by: z
    .string()
    .optional()
    .describe(
      "Id of the node that replaces this one; creates a 'supersedes' edge from the new node to this one.",
    ),
};

export const description =
  "Soft-delete a node: mark it invalid so it stops appearing in normal search, while keeping it fully reconstructable " +
  "(nothing is ever hard-deleted; the node stays visible with `history:true`). When a newer node replaces this one, " +
  "pass `superseded_by` to record the link. Prefer this over leaving stale facts around. Returns the invalidated envelope.";

export async function handler(ctx: Ctx, args: ToolArgs<typeof schema>) {
  const hints = touchOrCreate(ctx, args.session_id);

  if (!ctx.repo.nodeExists(args.id)) throw new Error(`node ${args.id} does not exist.`);
  if (args.superseded_by && !ctx.repo.nodeExists(args.superseded_by)) {
    throw new Error(`superseded_by node ${args.superseded_by} does not exist.`);
  }
  // Code mirrors are maintained by the indexer; retiring one by hand would just come
  // back on the next re-index. External mirrors (origin != 'repo') are agent-curated,
  // so the agent legitimately retires a stale record here.
  const prov = ctx.repo.nodeOrigin(args.id);
  if (prov?.memory_kind === "mirror" && prov.origin === "repo") {
    throw new Error(
      "code symbols are maintained by the indexer, not invalidated by hand; run `code_index` to refresh them.",
    );
  }

  const envelope = ctx.repo.invalidateNode(args.id, {
    ts: ctx.now(),
    superseded_by: args.superseded_by,
    session_id: args.session_id,
  });

  ctx.repo.logEvent(
    "invalidate",
    args.session_id,
    args.id,
    { reason: args.reason, superseded_by: args.superseded_by ?? null },
    ctx.now(),
  );
  return hints.length ? { ...envelope, hints } : envelope;
}
