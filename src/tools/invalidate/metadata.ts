import { z } from "zod";
import { ToolName } from "@/tools/contracts";

export const metadata = {
  name: ToolName.INVALIDATE,

  description:
    "Soft-delete a node: mark it invalid so it stops appearing in normal search, while keeping it fully reconstructable " +
    "(nothing is ever hard-deleted; the node stays visible with `history:true`). When a newer node replaces this one, " +
    "pass `superseded_by` to record the link. Prefer this over leaving stale facts around. Returns the invalidated envelope.",

  schema: {
    session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
    id: z.string().describe("Id of the node to invalidate (soft-delete)."),
    reason: z.string().min(1).describe("Why it's no longer valid — recorded in the activity log."),
    superseded_by: z
      .string()
      .optional()
      .describe(
        "Id of the node that replaces this one; creates a 'supersedes' edge from the new node to this one.",
      ),
  },
};
