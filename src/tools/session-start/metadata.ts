import { z } from "zod";
import { ToolName } from "@/tools/contracts";

export const metadata = {
  name: ToolName.SESSION_START,
  description:
    "Begin a work session. Call this FIRST, before any other memory tool. Returns a fresh `session_id` (pass it to " +
    "every other tool) plus a compact working set for the project: recent semantic facts/decisions, the last couple " +
    "of checkpoints (with full content, so you know where you left off), open tasks, and a stats line — all trimmed to " +
    "a small token budget. Read this to orient before you start.",
  schema: {
    project: z
      .string()
      .optional()
      .describe("Project scope to focus the working set; omit for a global view."),
  },
};
