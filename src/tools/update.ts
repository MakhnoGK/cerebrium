import { z } from "zod";
import type { Ctx, ToolArgs } from "@/tools/context";
import { touchOrCreate } from "@/tools/context";

const MAX_CONTENT = 50_000;

export const schema = {
  session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
  id: z.string().describe("Id of the SEMANTIC node to revise."),
  content: z
    .string()
    .optional()
    .describe("New markdown body (replaces current). Omit to change only the title."),
  title: z.string().min(1).optional().describe("New title."),
  reason: z.string().optional().describe("Why this revision — stored in the node's history."),
};

export const description =
  "Revise a semantic node by appending a new revision (history is preserved; the old text stays reachable via " +
  "`get` with `rev`). Use this to correct or extend a fact/decision rather than writing a near-duplicate. Episodic " +
  "nodes are write-once and CANNOT be updated — record what changed as a new node instead. Returns the updated envelope.";

export async function handler(ctx: Ctx, args: ToolArgs<typeof schema>) {
  const hints = touchOrCreate(ctx, args.session_id);

  const current = ctx.repo.envelope(args.id);
  if (!current) throw new Error(`node ${args.id} does not exist.`);
  if (current.kind === "episodic") {
    throw new Error("episodic memories are write-once; write a new node.");
  }
  if (current.kind === "mirror") {
    throw new Error(
      "symbol/mirror nodes are re-indexed, not hand-edited; run `code_index` to refresh them. To record insight ABOUT " +
        "this code, write a semantic node and `link` it with a 'documents' edge.",
    );
  }
  if (args.content === undefined && args.title === undefined) {
    throw new Error("nothing to update — provide `content` and/or `title`.");
  }
  if (args.content !== undefined && args.content.length > MAX_CONTENT) {
    throw new Error(
      `content is ${args.content.length} chars; the limit is ${MAX_CONTENT}. Split this into smaller linked notes.`,
    );
  }

  const envelope = ctx.repo.addRevision(args.id, {
    content: args.content,
    title: args.title,
    session_id: args.session_id,
    reason: args.reason ?? null,
    ts: ctx.now(),
  });

  ctx.repo.logEvent(
    "update",
    args.session_id,
    args.id,
    { rev: envelope.rev, reason: args.reason ?? null },
    ctx.now(),
  );
  return hints.length ? { ...envelope, hints } : envelope;
}
