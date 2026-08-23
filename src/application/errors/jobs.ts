import { AGENT_JOB_PREFIX } from "@/core/vocab";

export class UnsubmittableJobKindError extends Error {
  constructor(kind: string, submittable: readonly string[]) {
    super(
      kind.startsWith(AGENT_JOB_PREFIX)
        ? `job kind '${kind}' is not submittable through the call surface: a job that spawns an ` +
            "external process is enqueued by the host that runs it, never by a caller asking the " +
            "kernel to run one."
        : `Unknown job kind '${kind}'. Submittable kinds are: ${submittable.join(", ")}.`,
    );
  }
}
