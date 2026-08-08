import { z } from "zod";
import { nodeIdsSchema, sessionIdSchema, ToolName } from "@/presentation/mcp/tools/contracts";

export const metadata = {
  name: ToolName.CHECKPOINT,

  description:
    "Record a session checkpoint before ending a work block. This is the tool to call when you're about to stop: it " +
    "writes an episodic `checkpoint` node (Summary / Decisions / Open threads) and links it to the nodes you touched, so " +
    "the next session's `session_start` can show you exactly where you left off. Returns the checkpoint's envelope.",

  schema: {
    session_id: sessionIdSchema,
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
    touched_node_ids: nodeIdsSchema
      .optional()
      .describe(
        "Exact live node ids copied from Cerebrium results; never invent, guess, or transform them. The checkpoint links to them via 'references'.",
      ),
  },
};
