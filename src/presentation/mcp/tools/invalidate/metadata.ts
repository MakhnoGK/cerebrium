import { z } from "zod";
import { nodeIdSchema, sessionIdSchema, ToolName } from "@/presentation/mcp/tools/contracts";

export const metadata = {
  name: ToolName.INVALIDATE,

  description:
    "Soft-delete a node: mark it invalid so it stops appearing in normal search, while keeping it fully reconstructable " +
    "(nothing is ever hard-deleted; the node stays visible with `history:true`). When a newer node replaces this one, " +
    "pass `superseded_by` to record the link. Prefer this over leaving stale facts around. Returns the invalidated envelope.",

  schema: {
    session_id: sessionIdSchema,
    id: nodeIdSchema,
    reason: z.string().min(1).describe("Why it's no longer valid — recorded in the activity log."),
    superseded_by: nodeIdSchema
      .optional()
      .describe(
        "Exact live replacement node id copied from a Cerebrium result; never invent, guess, or transform it. Creates a 'supersedes' edge from the new node to this one.",
      ),
  },
};
