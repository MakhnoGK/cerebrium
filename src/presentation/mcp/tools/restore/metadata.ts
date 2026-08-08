import { z } from "zod";
import { nodeIdSchema, sessionIdSchema, ToolName } from "@/presentation/mcp/tools/contracts";

export const metadata = {
  name: ToolName.RESTORE,

  description:
    "Bring a soft-deleted node back into normal retrieval — the inverse of `invalidate`, for when a node was retired " +
    "in error (a consolidation merge that swallowed a living index, a supersede that turned out to be wrong). The node " +
    "keeps its id, its whole revision history and its edges, which is what re-publishing the content under a new id " +
    "would throw away. Any `supersedes` edge into it is retired in the same write, since nothing replaces it any more. " +
    "Referrers that the original supersession moved onto the successor are NOT moved back — they have pointed there " +
    "ever since, and returning them is a separate judgement you can make with `link`. Errors if the node is not " +
    "currently invalidated. Returns the restored envelope.",

  schema: {
    session_id: sessionIdSchema,
    id: nodeIdSchema,
    reason: z
      .string()
      .min(1)
      .describe("Why it should not have been retired — recorded in the activity log."),
  },
};
