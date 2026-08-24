import { z } from "zod";
import { SUBMITTABLE_JOB_KINDS } from "@/application/use-cases";
import { sessionIdSchema, ToolName } from "@/presentation/mcp/tools/contracts";

export const metadata = {
  name: ToolName.JOB_SUBMIT,

  description:
    "Queue long-running kernel work and get a job id back immediately, instead of holding a tool call open " +
    "until it finishes. Use this for `code_index` whenever the index might outlast your client's own request " +
    "timeout — an incremental index of one repo measures ~20s, a cold or forced one far longer, and an MCP " +
    "client that gives up first reports a timeout for work that is still running and will still succeed. " +
    "Submitting returns at once; poll `job_status` with the returned id to see how it ended. " +
    `Submittable kinds: ${SUBMITTABLE_JOB_KINDS.join(", ")}. Jobs that would spawn an external process are ` +
    "not submittable here — they are enqueued by the host that runs them, never by asking the kernel.",

  schema: {
    session_id: sessionIdSchema,
    kind: z.string().describe(`What to run. One of: ${SUBMITTABLE_JOB_KINDS.join(", ")}.`),
    payload: z
      .record(z.unknown())
      .optional()
      .describe(
        "Arguments for the job, shaped like the synchronous call's own. For `code.index`: " +
          "`repo`, `path`, `force` — all optional, and omitting them all indexes every configured root.",
      ),
    scheduled_for: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe(
        "ISO-8601 instant before which the job must not start. Omit to run as soon as the queue reaches it.",
      ),
  },
};
