import { type JobRow } from "@/domain/ports/storage";
import { AgentRunService } from "@/application/services/agent-run.service";
import {
  CLAIM_JOB,
  ENQUEUE_AGENT_JOB,
  FINISH_JOB,
  RENEW_JOB,
  useCase,
  type ClaimJob,
  type ClaimJobArgs,
  type EnqueueAgentJob,
  type EnqueueAgentJobArgs,
  type FinishJob,
  type FinishJobArgs,
  type RenewJob,
  type RenewJobArgs,
} from "@/application/use-cases/contracts";

@useCase(CLAIM_JOB)
export class LocalClaimJob implements ClaimJob {
  constructor(private readonly runs: AgentRunService) {}

  async invoke(args: ClaimJobArgs): Promise<JobRow | null> {
    return Promise.resolve(await this.runs.claim(args.kinds, args.owner));
  }
}

@useCase(RENEW_JOB)
export class LocalRenewJob implements RenewJob {
  constructor(private readonly runs: AgentRunService) {}

  async invoke(args: RenewJobArgs): Promise<boolean> {
    return Promise.resolve(await this.runs.renew(args.id, args.owner));
  }
}

@useCase(FINISH_JOB)
export class LocalFinishJob implements FinishJob {
  constructor(private readonly runs: AgentRunService) {}

  invoke(args: FinishJobArgs): Promise<boolean> {
    return this.runs.finish(args.id, args.owner, args.report);
  }
}

@useCase(ENQUEUE_AGENT_JOB)
export class LocalEnqueueAgentJob implements EnqueueAgentJob {
  constructor(private readonly runs: AgentRunService) {}

  async invoke(args: EnqueueAgentJobArgs): Promise<JobRow | null> {
    return Promise.resolve(await this.runs.enqueue(args.kind, args.payload ?? {}, args.every_ms));
  }
}
