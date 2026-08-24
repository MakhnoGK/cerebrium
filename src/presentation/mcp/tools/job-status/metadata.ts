import { z } from "zod";
import { sessionIdSchema, ToolName } from "@/presentation/mcp/tools/contracts";

export const metadata = {
  name: ToolName.JOB_STATUS,

  description:
    "How a queued job is doing. Pass the `id` returned by `job_submit` to poll one job, or omit it to list " +
    "the most recent jobs. A job reads `pending` (queued), `running` (a consumer holds it), `done` (with its " +
    "`result`), `failed` (with `last_error`, after exhausting `max_attempts`) or `cancelled`. " +
    "A failure with attempts left goes back to `pending` rather than reporting failed, so a job that has " +
    "`last_error` set while still `pending` is one that is being retried.",

  schema: {
    session_id: sessionIdSchema.optional(),
    id: z
      .string()
      .optional()
      .describe("The job id returned by `job_submit`. Omit to list recent jobs."),
    kind: z.string().optional().describe("Restrict the listing to one kind."),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("How many recent jobs to list (default 10, max 50). Ignored when `id` is given."),
  },
};
