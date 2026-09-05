import { injectable } from "tsyringe";
import { BaseRepo } from "@/db/repositories/base";
import { JobState, TERMINAL_JOB_STATES } from "@/core/vocab";

export interface JobRow {
  id: string;
  kind: string;
  payload_json: string;
  state: string;
  scheduled_for: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempts: number;
  max_attempts: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
  result_json: string | null;
  last_error: string | null;
  submitted_by: string | null;
}

export interface SubmitJob {
  id: string;
  kind: string;
  payload: unknown;
  scheduled_for: string;
  now: string;
  max_attempts?: number;
  submitted_by?: string | null;
}

const TERMINAL = TERMINAL_JOB_STATES.map((s) => `'${s}'`).join(", ");

// The work queue. Every mutation is expressed so that it is safe against a second consumer
// and against a consumer that came back from the dead: claims are conditional on the row
// still being claimable, and completions on the caller still holding the lease.
@injectable()
export class JobsRepo extends BaseRepo {
  submit(job: SubmitJob): JobRow {
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO jobs
             (id, kind, payload_json, state, scheduled_for, attempts, max_attempts,
              created_at, updated_at, submitted_by)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        )
        .run(
          job.id,
          job.kind,
          JSON.stringify(job.payload ?? {}),
          JobState.PENDING,
          job.scheduled_for,
          job.max_attempts ?? 3,
          job.now,
          job.now,
          job.submitted_by ?? null,
        );
    });

    return this.byId(job.id)!;
  }

  byId(id: string): JobRow | null {
    return (
      (this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined) ?? null
    );
  }

  // Take the oldest due job whose kind this consumer handles. The UPDATE carries the whole
  // claimability test in its WHERE, so two consumers racing on the same row cannot both win:
  // the loser's UPDATE matches nothing and it moves to the next candidate.
  //
  // A `running` row whose lease has expired is claimable again. That is the crash path — the
  // consumer died without reporting — and it is why the lease exists per row rather than one
  // lease for the whole queue.
  claim(opts: { kinds: string[]; owner: string; now: string; leaseMs: number }): JobRow | null {
    if (!opts.kinds.length) return null;

    const placeholders = opts.kinds.map(() => "?").join(", ");
    const expires = new Date(Date.parse(opts.now) + opts.leaseMs).toISOString();

    return this.tx(() => {
      const candidate = this.db
        .prepare(
          `SELECT id FROM jobs
            WHERE kind IN (${placeholders})
              AND scheduled_for <= ?
              AND (state = ? OR (state = ? AND lease_expires_at <= ?))
              AND attempts < max_attempts
            ORDER BY scheduled_for
            LIMIT 1`,
        )
        .get(...opts.kinds, opts.now, JobState.PENDING, JobState.RUNNING, opts.now) as
        { id: string } | undefined;

      if (candidate === undefined) return null;

      const claimed = this.db
        .prepare(
          `UPDATE jobs
              SET state = ?, lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1,
                  started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE id = ?
              AND scheduled_for <= ?
              AND (state = ? OR (state = ? AND lease_expires_at <= ?))
              AND attempts < max_attempts`,
        )
        .run(
          JobState.RUNNING,
          opts.owner,
          expires,
          opts.now,
          opts.now,
          candidate.id,
          opts.now,
          JobState.PENDING,
          JobState.RUNNING,
          opts.now,
        );

      return claimed.changes === 0 ? null : this.byId(candidate.id);
    });
  }

  // Extend the lease of a job still being worked on. A long job must not have its row
  // stolen just because it is slow — a full code index is minutes.
  renew(id: string, owner: string, now: string, leaseMs: number): boolean {
    const expires = new Date(Date.parse(now) + leaseMs).toISOString();

    return this.tx(
      () =>
        this.db
          .prepare(
            `UPDATE jobs SET lease_expires_at = ?, updated_at = ?
              WHERE id = ? AND state = ? AND lease_owner = ?`,
          )
          .run(expires, now, id, JobState.RUNNING, owner).changes > 0,
    );
  }

  succeed(id: string, owner: string, result: unknown, now: string): boolean {
    return this.finish(id, owner, now, {
      state: JobState.DONE,
      result: JSON.stringify(result ?? null),
      error: null,
    });
  }

  // A failure that has attempts left goes back to `pending` for the next consumer; one that
  // has exhausted them is terminal. `attempts` was already incremented by the claim, so the
  // decision is readable from the row itself rather than from a counter held in the worker.
  fail(id: string, owner: string, error: string, now: string): boolean {
    const row = this.byId(id);

    if (row === null) return false;

    return row.attempts >= row.max_attempts
      ? this.finish(id, owner, now, { state: JobState.FAILED, result: null, error })
      : this.tx(
          () =>
            this.db
              .prepare(
                `UPDATE jobs
                    SET state = ?, lease_owner = NULL, lease_expires_at = NULL,
                        last_error = ?, updated_at = ?
                  WHERE id = ? AND state = ? AND lease_owner = ?`,
              )
              .run(JobState.PENDING, error, now, id, JobState.RUNNING, owner).changes > 0,
        );
  }

  cancel(id: string, now: string): boolean {
    return this.tx(
      () =>
        this.db
          .prepare(
            `UPDATE jobs
                SET state = ?, lease_owner = NULL, lease_expires_at = NULL,
                    ended_at = ?, updated_at = ?
              WHERE id = ? AND state NOT IN (${TERMINAL})`,
          )
          .run(JobState.CANCELLED, now, now, id).changes > 0,
    );
  }

  // True when a job of this kind is already queued or in flight, so the scheduler does not
  // pile a second copy of recurring maintenance on top of one that is still running.
  hasOpen(kind: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM jobs WHERE kind = ? AND state NOT IN (${TERMINAL}) LIMIT 1`)
        .get(kind) !== undefined
    );
  }

  // Recurring work that enqueues itself: skipped while one of its kind is open, and while
  // the last one ended less than `everyMs` ago. The whole decision sits inside one
  // transaction because the alternative is a check-then-submit across a socket, where two
  // schedulers both read "due" and both insert.
  submitIfDue(job: SubmitJob & { everyMs: number }): JobRow | null {
    return this.tx(() => {
      if (this.hasOpen(job.kind)) return null;

      const last = this.db
        .prepare(
          `SELECT ended_at FROM jobs
            WHERE kind = ? AND ended_at IS NOT NULL
            ORDER BY ended_at DESC
            LIMIT 1`,
        )
        .get(job.kind) as { ended_at: string } | undefined;

      if (last !== undefined && Date.parse(job.now) - Date.parse(last.ended_at) < job.everyMs) {
        return null;
      }

      return this.submit(job);
    });
  }

  recent(opts: { kind?: string; limit: number }): JobRow[] {
    const where = opts.kind === undefined ? "" : "WHERE kind = ?";
    const params = opts.kind === undefined ? [] : [opts.kind];

    return this.db
      .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, opts.limit) as JobRow[];
  }

  counts(): Record<string, number> {
    const rows = this.db.prepare("SELECT state, COUNT(*) n FROM jobs GROUP BY state").all() as {
      state: string;
      n: number;
    }[];

    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }

  // Boot recovery, the same lesson `closeAbandonedRuns` taught: a consumer killed outright
  // leaves a `running` row that nobody will ever report on, and only the process starting
  // next can say so. Returns how many were reopened or retired.
  reconcileAbandoned(now: string, error: string): number {
    return this.tx(() => {
      const retired = this.db
        .prepare(
          `UPDATE jobs
              SET state = ?, lease_owner = NULL, lease_expires_at = NULL,
                  ended_at = COALESCE(ended_at, updated_at), last_error = ?, updated_at = ?
            WHERE state = ? AND attempts >= max_attempts`,
        )
        .run(JobState.FAILED, error, now, JobState.RUNNING).changes;

      const reopened = this.db
        .prepare(
          `UPDATE jobs
              SET state = ?, lease_owner = NULL, lease_expires_at = NULL,
                  last_error = ?, updated_at = ?
            WHERE state = ? AND attempts < max_attempts`,
        )
        .run(JobState.PENDING, error, now, JobState.RUNNING).changes;

      return retired + reopened;
    });
  }

  private finish(
    id: string,
    owner: string,
    now: string,
    outcome: { state: JobState; result: string | null; error: string | null },
  ): boolean {
    return this.tx(
      () =>
        this.db
          .prepare(
            `UPDATE jobs
                SET state = ?, lease_owner = NULL, lease_expires_at = NULL,
                    ended_at = ?, updated_at = ?, result_json = ?, last_error = ?
              WHERE id = ? AND state = ? AND lease_owner = ?`,
          )
          .run(outcome.state, now, now, outcome.result, outcome.error, id, JobState.RUNNING, owner)
          .changes > 0,
    );
  }
}
