import { z } from "zod";
import { ToolName } from "@/presentation/mcp/tools/contracts";

export const metadata = {
  name: ToolName.SESSION_START,
  description:
    "Begin a work session. This is the sole tool that creates an agent session_id. Call it FIRST, before any other " +
    "memory tool, then copy the returned `session_id` verbatim into every later call; never invent, guess, transform, " +
    "or reuse one from another task. Returns a fresh `session_id` plus a compact working set for the project: recent " +
    "semantic facts/decisions, the last couple " +
    "of checkpoints (with full content, so you know where you left off), open tasks, and a stats line — all trimmed to " +
    "a small token budget. Read this to orient before you start.",
  schema: {
    project: z
      .string()
      .optional()
      .describe("Project scope to focus the working set; omit for a global view."),
  },
};
