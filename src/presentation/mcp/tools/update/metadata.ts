import { z } from "zod";
import { ToolName } from "@/presentation/mcp/tools/contracts";

export const metadata = {
  name: ToolName.UPDATE,

  description:
    "Revise a semantic node by appending a new revision (history is preserved; the old text stays reachable via " +
    "`get` with `rev`). Use this to correct or extend a fact/decision rather than writing a near-duplicate. Episodic " +
    "nodes are write-once and CANNOT be updated — record what changed as a new node instead. A revision that leaves the " +
    "body long enough for every reader to pay for it draws a `context_notes` line saying so; it is advice, never a limit. " +
    "Returns the updated envelope.",

  schema: {
    session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
    id: z.string().describe("Id of the SEMANTIC node to revise."),
    content: z
      .string()
      .optional()
      .describe("New markdown body (replaces current). Omit to change only the title."),
    title: z.string().min(1).optional().describe("New title."),
    reason: z.string().optional().describe("Why this revision — stored in the node's history."),
    event_from: z
      .string()
      .datetime()
      .optional()
      .describe(
        "Event axis (ISO-8601): when the fact itself became true, as opposed to when you " +
          "wrote it down. Omit unless you actually know it — omitted means no claim, and " +
          "reads treat that as an open interval rather than as unknown.",
      ),
    event_to: z
      .string()
      .datetime()
      .optional()
      .describe(
        "Event axis (ISO-8601): when the fact stopped being true. Must not precede `event_from`.",
      ),
  },
};
