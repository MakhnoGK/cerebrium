import { injectable } from "tsyringe";
import { JobState, TERMINAL_JOB_STATES } from "@cerebrium/contracts/vocab";
import type { JobRow, JobsRepo, SubmitJob } from "@/domain/ports/storage";
import { PgBaseRepo } from "@/db/postgres/base";

const TERMINAL = TERMINAL_JOB_STATES.map((s) => `'${s}'`).join(", ");

// Claims are conditional on the row still being claimable, and completions on the caller
// still holding the lease. See db/sqlite/jobs.ts.
@injectable()
export class PgJobsRepo extends PgBaseRepo implements JobsRepo {
  async submit(job: SubmitJob): Promise<JobRow> {
    return this.tx(async () => {
      await this.db.query(
        `INSERT INTO jobs
           (id, kind, payload_json, state, scheduled_for, attempts, max_attempts,
            created_at, updated_at, submitted_by)
         VALUES (@id, @kind, @payload, @state, @scheduled_for, 0, @max_attempts, @now, @now, @submitted_by)`,
        {
          id: job.id,
          kind: job.kind,
          payload: JSON.stringify(job.payload ?? {}),
          state: JobState.PENDING,
          scheduled_for: job.scheduled_for,
          max_attempts: job.max_attempts ?? 3,
          now: job.now,
          submitted_by: job.submitted_by ?? null,
        },
      );

      return (await this.byId(job.id))!;
    });
  }

  async byId(id: string): Promise<JobRow | null> {
    return (await this.one<JobRow>("SELECT * FROM jobs WHERE id = @id", { id })) ?? null;
  }

  async claim(opts: {
    kinds: string[];
    owner: string;
    now: string;
    leaseMs: number;
  }): Promise<JobRow | null> {
    if (!opts.kinds.length) return null;

    const expires = new Date(Date.parse(opts.now) + opts.leaseMs).toISOString();
    const claimable = `scheduled_for <= @now
        AND (state = @pending OR (state = @running AND lease_expires_at <= @now))
        AND attempts < max_attempts`;
    const params = {
      kinds: opts.kinds,
      now: opts.now,
      pending: JobState.PENDING,
      running: JobState.RUNNING,
    };

    return this.tx(async () => {
      const candidate = await this.one<{ id: string }>(
        `SELECT id FROM jobs
          WHERE kind = ANY(@kinds) AND ${claimable}
          ORDER BY scheduled_for, id
          LIMIT 1`,
        params,
      );

      if (candidate === undefined) return null;

      const claimed =
        (
          await this.db.query(
            `UPDATE jobs
                SET state = @running, lease_owner = @owner, lease_expires_at = @expires,
                    attempts = attempts + 1, started_at = COALESCE(started_at, @now), updated_at = @now
              WHERE id = @id AND ${claimable}`,
            { ...params, owner: opts.owner, expires, id: candidate.id },
          )
        ).rowCount ?? 0;

      return claimed === 0 ? null : this.byId(candidate.id);
    });
  }

  async renew(id: string, owner: string, now: string, leaseMs: number): Promise<boolean> {
    const expires = new Date(Date.parse(now) + leaseMs).toISOString();

    return (
      (await this.run(
        `UPDATE jobs SET lease_expires_at = @expires, updated_at = @now
          WHERE id = @id AND state = @running AND lease_owner = @owner`,
        { expires, now, id, running: JobState.RUNNING, owner },
      )) > 0
    );
  }

  async succeed(id: string, owner: string, result: unknown, now: string): Promise<boolean> {
    return this.finish(id, owner, now, {
      state: JobState.DONE,
      result: JSON.stringify(result ?? null),
      error: null,
    });
  }

  async fail(id: string, owner: string, error: string, now: string): Promise<boolean> {
    const row = await this.byId(id);

    if (row === null) return false;

    if (row.attempts >= row.max_attempts) {
      return this.finish(id, owner, now, { state: JobState.FAILED, result: null, error });
    }

    return (
      (await this.run(
        `UPDATE jobs
            SET state = @pending, lease_owner = NULL, lease_expires_at = NULL,
                last_error = @error, updated_at = @now
          WHERE id = @id AND state = @running AND lease_owner = @owner`,
        { pending: JobState.PENDING, error, now, id, running: JobState.RUNNING, owner },
      )) > 0
    );
  }

  async cancel(id: string, now: string): Promise<boolean> {
    return (
      (await this.run(
        `UPDATE jobs
            SET state = @cancelled, lease_owner = NULL, lease_expires_at = NULL,
                ended_at = @now, updated_at = @now
          WHERE id = @id AND state NOT IN (${TERMINAL})`,
        { cancelled: JobState.CANCELLED, now, id },
      )) > 0
    );
  }

  async hasOpen(kind: string): Promise<boolean> {
    return (
      (await this.one(
        `SELECT 1 FROM jobs WHERE kind = @kind AND state NOT IN (${TERMINAL}) LIMIT 1`,
        { kind },
      )) !== undefined
    );
  }

  async submitIfDue(job: SubmitJob & { everyMs: number }): Promise<JobRow | null> {
    return this.tx(async () => {
      if (await this.hasOpen(job.kind)) return null;

      const last = await this.one<{ ended_at: string }>(
        `SELECT ended_at FROM jobs
          WHERE kind = @kind AND ended_at IS NOT NULL
          ORDER BY ended_at DESC
          LIMIT 1`,
        { kind: job.kind },
      );

      if (last !== undefined && Date.parse(job.now) - Date.parse(last.ended_at) < job.everyMs) {
        return null;
      }

      return this.submit(job);
    });
  }

  async recent(opts: { kind?: string; limit: number }): Promise<JobRow[]> {
    const where = opts.kind === undefined ? "" : "WHERE kind = @kind";

    return this.all<JobRow>(
      `SELECT * FROM jobs ${where} ORDER BY created_at DESC, id DESC LIMIT @limit`,
      { limit: opts.limit, ...(opts.kind === undefined ? {} : { kind: opts.kind }) },
    );
  }

  async counts(): Promise<Record<string, number>> {
    const rows = await this.all<{ state: string; n: number }>(
      "SELECT state, COUNT(*) AS n FROM jobs GROUP BY state",
    );

    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }

  async reconcileAbandoned(now: string, error: string): Promise<number> {
    return this.tx(async () => {
      const retired =
        (
          await this.db.query(
            `UPDATE jobs
                SET state = @failed, lease_owner = NULL, lease_expires_at = NULL,
                    ended_at = COALESCE(ended_at, updated_at), last_error = @error, updated_at = @now
              WHERE state = @running AND attempts >= max_attempts`,
            { failed: JobState.FAILED, error, now, running: JobState.RUNNING },
          )
        ).rowCount ?? 0;

      const reopened =
        (
          await this.db.query(
            `UPDATE jobs
                SET state = @pending, lease_owner = NULL, lease_expires_at = NULL,
                    last_error = @error, updated_at = @now
              WHERE state = @running AND attempts < max_attempts`,
            { pending: JobState.PENDING, error, now, running: JobState.RUNNING },
          )
        ).rowCount ?? 0;

      return retired + reopened;
    });
  }

  private async finish(
    id: string,
    owner: string,
    now: string,
    outcome: { state: JobState; result: string | null; error: string | null },
  ): Promise<boolean> {
    return (
      (await this.run(
        `UPDATE jobs
            SET state = @state, lease_owner = NULL, lease_expires_at = NULL,
                ended_at = @now, updated_at = @now, result_json = @result, last_error = @error
          WHERE id = @id AND state = @running AND lease_owner = @owner`,
        { ...outcome, now, id, running: JobState.RUNNING, owner },
      )) > 0
    );
  }
}
