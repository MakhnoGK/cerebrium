import { inject, injectable } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { CodeIndexService } from "@/application/services/code-index.service";
import { SessionService } from "@/application/services/session.service";
import { JobsRepo, type JobRow } from "@/db/repositories";
import type { Writer } from "@/runtime/client-identity";
import { newId } from "@/core/ids";
import { JobKind } from "@/core/vocab";

// The job runner works behind no MCP handshake, so it names itself — the same way the
// consolidation sweep does. What it indexes is attributable to this writer rather than to
// whoever happened to submit the job.
const JOB_WRITER: Writer = { client: "cerebrium-jobs", version: null };

// Long enough that a slow claim-to-first-renew gap cannot lose the row, short enough that a
// killed consumer's work is picked up again within a sweep interval.
const LEASE_MS = 120_000;
const RENEW_MS = 30_000;
const MAX_ERROR_CHARS = 500;

export interface JobTickResult {
  claimed: number;
  succeeded: number;
  failed: number;
  yielded: boolean;
}

export interface JobTickOptions {
  // True while a client is waiting. Checked between jobs, never inside one: a code index is
  // a single long call with no safe place to stop halfway.
  shouldYield?: () => boolean;
  // Cap per tick, so one very full queue cannot hold the daemon loop for an unbounded time.
  max?: number;
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);

  return (message || "unknown job error").slice(0, MAX_ERROR_CHARS);
}

type Handler = (payload: Record<string, unknown>, sessionId: string) => Promise<unknown>;

// Consumes the kernel half of the work queue. It claims only the kinds it declares, which
// is what keeps `agent.*` — work that means spawning a process — out of the daemon without
// a flag saying so: nothing here can run it, so nothing here has to refuse it.
@injectable()
export class JobWorker {
  private readonly ownerId = newId();
  private stopped = false;

  private readonly handlers: Record<string, Handler> = {
    [JobKind.CODE_INDEX]: async (payload, sessionId) => {
      const targets = this.indexer.resolveTargets({
        repo: typeof payload.repo === "string" ? payload.repo : undefined,
        path: typeof payload.path === "string" ? payload.path : undefined,
      });

      return {
        results: await this.indexer.indexTargets(targets, {
          session_id: sessionId,
          force: payload.force === true,
        }),
      };
    },
  };

  constructor(
    private readonly jobs: JobsRepo,
    private readonly indexer: CodeIndexService,
    private readonly sessions: SessionService,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  get kinds(): string[] {
    return Object.keys(this.handlers);
  }

  stop(): void {
    this.stopped = true;
  }

  // Reopens whatever a previous process left running. Same lesson as the sweep's abandoned
  // runs: only the process that starts next can say a job nobody holds is not in progress.
  reconcile(): number {
    return this.jobs.reconcileAbandoned(
      this.clock.now(),
      "the job runner exited before the job finished",
    );
  }

  async tick(opts: JobTickOptions = {}): Promise<JobTickResult> {
    const result: JobTickResult = { claimed: 0, succeeded: 0, failed: 0, yielded: false };
    const shouldYield = opts.shouldYield ?? (() => false);
    const max = opts.max ?? 1;

    while (result.claimed < max && !this.stopped) {
      if (shouldYield()) {
        result.yielded = true;
        break;
      }

      const job = this.jobs.claim({
        kinds: this.kinds,
        owner: this.ownerId,
        now: this.clock.now(),
        leaseMs: LEASE_MS,
      });

      if (job === null) break;

      result.claimed++;

      if (await this.run(job)) result.succeeded++;
      else result.failed++;
    }

    return result;
  }

  private async run(job: JobRow): Promise<boolean> {
    const handler = this.handlers[job.kind];

    if (handler === undefined) {
      // Claimed a kind this build cannot run — only reachable if `handlers` and the claim
      // list ever drift. Fail it rather than hold the lease until it expires.
      this.jobs.fail(job.id, this.ownerId, `no handler for job kind ${job.kind}`, this.clock.now());

      return false;
    }

    // A full index runs for minutes on one await, so the lease has to be renewed from a
    // timer rather than between steps. Without it the row looks abandoned mid-run and a
    // second consumer starts the same work.
    const renew = setInterval(() => {
      this.jobs.renew(job.id, this.ownerId, this.clock.now(), LEASE_MS);
    }, RENEW_MS);

    renew.unref();

    const sessionId = newId();

    try {
      this.sessions.startSession(sessionId, null, this.clock.now(), JOB_WRITER);

      const outcome = await handler(this.payloadOf(job), sessionId);

      this.jobs.succeed(job.id, this.ownerId, outcome, this.clock.now());

      return true;
    } catch (err) {
      this.jobs.fail(job.id, this.ownerId, errorText(err), this.clock.now());

      return false;
    } finally {
      clearInterval(renew);
    }
  }

  // A payload that will not parse is the job's own fault, not the runner's: treat it as
  // empty so the handler's own validation reports it, rather than crashing the tick.
  private payloadOf(job: JobRow): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(job.payload_json);

      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
}
