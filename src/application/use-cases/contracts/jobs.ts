import { useCaseToken, type UseCase } from "@/application/use-cases/contracts/use-case";
import { JobKind } from "@/core/vocab";

// What a caller may submit through the call surface. `agent.*` is deliberately absent: a
// job that spawns an external process is enqueued by the host that owns that process, never
// by an agent asking the kernel to run one. Keeping the list here rather than accepting any
// string is what makes that boundary a rejection instead of a convention.
export const SUBMITTABLE_JOB_KINDS: readonly string[] = [JobKind.CODE_INDEX];

export function isSubmittableKind(kind: string): boolean {
  return SUBMITTABLE_JOB_KINDS.includes(kind);
}

export interface JobEnvelope {
  id: string;
  kind: string;
  state: string;
  scheduled_for: string;
  attempts: number;
  max_attempts: number;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  last_error: string | null;
  result?: unknown;
}

export interface SubmitJobArgs {
  session_id: string;
  kind: string;
  payload?: Record<string, unknown>;
  scheduled_for?: string;
}

export interface SubmitJobResult {
  job: JobEnvelope;
}

export type SubmitJob = UseCase<SubmitJobArgs, SubmitJobResult>;

export const SUBMIT_JOB = useCaseToken<SubmitJobArgs, SubmitJobResult>("SubmitJob");

export interface JobStatusArgs {
  session_id?: string;
  id?: string;
  kind?: string;
  limit?: number;
}

export interface JobStatusResult {
  jobs: JobEnvelope[];
}

export type JobStatus = UseCase<JobStatusArgs, JobStatusResult>;

export const JOB_STATUS = useCaseToken<JobStatusArgs, JobStatusResult>("JobStatus");
