import { useCaseToken, type UseCase } from "@/application/use-cases/contracts/use-case";
import type { JobRow } from "@/db/repositories";

// The runner host's side of the queue. These have tokens like any other use case, but they
// are deliberately NOT on `CALL_SURFACE`: claiming and reporting a job is operational, and
// putting it there would hand the queue's internals to every principal that can call the
// kernel. They are reachable only as daemon socket methods, whose trust boundary is the
// socket's filesystem permissions — the same one `status` already relies on.

export interface AgentRunReport {
  exit: string;
  result: string | null;
  cost_usd: number | null;
  turns: number | null;
  duration_ms: number;
  model: string | null;
  permission_denials: number;
  error: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | null;
}

export interface ClaimJobArgs {
  kinds: string[];
  owner: string;
}

export type ClaimJob = UseCase<ClaimJobArgs, JobRow | null>;

export const CLAIM_JOB = useCaseToken<ClaimJobArgs, JobRow | null>("ClaimJob");

export interface RenewJobArgs {
  id: string;
  owner: string;
}

export type RenewJob = UseCase<RenewJobArgs, boolean>;

export const RENEW_JOB = useCaseToken<RenewJobArgs, boolean>("RenewJob");

export interface FinishJobArgs {
  id: string;
  owner: string;
  report: AgentRunReport;
}

export type FinishJob = UseCase<FinishJobArgs, boolean>;

export const FINISH_JOB = useCaseToken<FinishJobArgs, boolean>("FinishJob");

export interface EnqueueAgentJobArgs {
  kind: string;
  payload?: Record<string, unknown>;
}

export type EnqueueAgentJob = UseCase<EnqueueAgentJobArgs, JobRow>;

export const ENQUEUE_AGENT_JOB = useCaseToken<EnqueueAgentJobArgs, JobRow>("EnqueueAgentJob");
