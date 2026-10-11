import { z } from "zod";
import { SUBMITTABLE_JOB_KINDS } from "@/application/use-cases";
import { sessionIdSchema, ToolName } from "@/presentation/mcp/tools/contracts";

export const metadata = {
  name: ToolName.JOB_SUBMIT,

  description:
    "Queue long-running kernel work and get a job id back immediately, instead of holding a tool call open " +
    "until it finishes. Submitting returns at once; poll `job_status` with the returned id to see how it ended. " +
    `Submittable kinds: ${SUBMITTABLE_JOB_KINDS.join(", ")}. A \`code.index\` job is refused: code is indexed ` +
    "by the plugin, so call `code_index` through cerebrium-plugin instead. Jobs that would spawn an external " +
    "process are not submittable here — they are enqueued by the host that runs them, never by asking the kernel.",

  schema: {
    session_id: sessionIdSchema,
    kind: z.string().describe(`What to run. One of: ${SUBMITTABLE_JOB_KINDS.join(", ")}.`),
    payload: z
      .record(z.unknown())
      .optional()
      .describe("Arguments for the job, shaped like the synchronous call's own."),
    scheduled_for: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe(
        "ISO-8601 instant before which the job must not start. Omit to run as soon as the queue reaches it.",
      ),
  },
};
