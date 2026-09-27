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

export const JOBS_REPO_TOKEN = Symbol("JobsRepo");

export interface JobsRepo {
  submit(job: SubmitJob): Promise<JobRow>;
  byId(id: string): Promise<JobRow | null>;
  claim(opts: {
    kinds: string[];
    owner: string;
    now: string;
    leaseMs: number;
  }): Promise<JobRow | null>;
  renew(id: string, owner: string, now: string, leaseMs: number): Promise<boolean>;
  succeed(id: string, owner: string, result: unknown, now: string): Promise<boolean>;
  fail(id: string, owner: string, error: string, now: string): Promise<boolean>;
  cancel(id: string, now: string): Promise<boolean>;
  hasOpen(kind: string): Promise<boolean>;
  submitIfDue(job: SubmitJob & { everyMs: number }): Promise<JobRow | null>;
  recent(opts: { kind?: string; limit: number }): Promise<JobRow[]>;
  counts(): Promise<Record<string, number>>;
  reconcileAbandoned(now: string, error: string): Promise<number>;
}
