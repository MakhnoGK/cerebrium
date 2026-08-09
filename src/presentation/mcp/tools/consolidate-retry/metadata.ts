import { z } from "zod";
import { sessionIdSchema, ToolName } from "@/presentation/mcp/tools/contracts";

export const metadata = {
  name: ToolName.CONSOLIDATE_RETRY,

  description:
    "Retry a failed consolidation candidate. This clears the proposal and generation error, and puts it back " +
    "in the pending state for the background sweep to retry. This is useful when the provider timed out " +
    "or returned an error.",

  schema: {
    session_id: sessionIdSchema,
    id: z.string().min(1).describe("The id of the consolidation candidate to retry"),
  },
};
