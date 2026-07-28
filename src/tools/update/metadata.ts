import { ToolName } from "@/tools/contracts";
import { z } from "zod";

export const metadata = {
  name: ToolName.UPDATE,

  description:
    "Revise a semantic node by appending a new revision (history is preserved; the old text stays reachable via " +
    "`get` with `rev`). Use this to correct or extend a fact/decision rather than writing a near-duplicate. Episodic " +
    "nodes are write-once and CANNOT be updated — record what changed as a new node instead. Returns the updated envelope.",

  schema: {
    session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
    id: z.string().describe("Id of the SEMANTIC node to revise."),
    content: z
      .string()
      .optional()
      .describe("New markdown body (replaces current). Omit to change only the title."),
    title: z.string().min(1).optional().describe("New title."),
    reason: z.string().optional().describe("Why this revision — stored in the node's history."),
  },
};
