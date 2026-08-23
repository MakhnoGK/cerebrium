import { inject } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { UnsubmittableJobKindError } from "@/application/errors";
import {
  isSubmittableKind,
  JOB_STATUS,
  SUBMIT_JOB,
  SUBMITTABLE_JOB_KINDS,
  useCase,
  type JobEnvelope,
  type JobStatus,
  type JobStatusArgs,
  type JobStatusResult,
  type SubmitJob,
  type SubmitJobArgs,
  type SubmitJobResult,
} from "@/application/use-cases/contracts";
import { JobsRepo, type JobRow } from "@/db/repositories";
import { ClientIdentity } from "@/runtime/client-identity";
import { newId } from "@/core/ids";
import { principalIdOf } from "@/core/vocab";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

// The result is stored as JSON and returned parsed, but a row written by an older build (or
// a consumer that stored something unparseable) must not fail the whole status call.
function parseResult(raw: string | null): unknown {
  if (raw === null) return undefined;

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function envelope(row: JobRow): JobEnvelope {
  const result = parseResult(row.result_json);

  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    scheduled_for: row.scheduled_for,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    created_at: row.created_at,
    started_at: row.started_at,
    ended_at: row.ended_at,
    last_error: row.last_error,
    ...(result === undefined ? {} : { result }),
  };
}

@useCase(SUBMIT_JOB)
export class LocalSubmitJob implements SubmitJob {
  constructor(
    private readonly jobs: JobsRepo,
    private readonly identity: ClientIdentity,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  invoke(args: SubmitJobArgs): Promise<SubmitJobResult> {
    // Rejected rather than thrown: the contract is a promise, and a caller that reaches for
    // `.catch` instead of `try` must not get a synchronous throw through the gap.
    if (!isSubmittableKind(args.kind)) {
      return Promise.reject(new UnsubmittableJobKindError(args.kind, SUBMITTABLE_JOB_KINDS));
    }

    const now = this.clock.now();

    return Promise.resolve({
      job: envelope(
        this.jobs.submit({
          id: newId(),
          kind: args.kind,
          payload: args.payload ?? {},
          scheduled_for: args.scheduled_for ?? now,
          now,
          submitted_by: principalIdOf(this.identity.get().client),
        }),
      ),
    });
  }
}

@useCase(JOB_STATUS)
export class LocalJobStatus implements JobStatus {
  constructor(private readonly jobs: JobsRepo) {}

  invoke(args: JobStatusArgs): Promise<JobStatusResult> {
    if (args.id !== undefined) {
      const row = this.jobs.byId(args.id);

      return Promise.resolve({ jobs: row === null ? [] : [envelope(row)] });
    }

    const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    return Promise.resolve({
      jobs: this.jobs.recent({ kind: args.kind, limit }).map(envelope),
    });
  }
}
