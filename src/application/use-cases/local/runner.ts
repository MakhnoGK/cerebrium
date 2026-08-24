import { AgentRunService } from "@/application/services/agent-run.service";
import {
  CLAIM_JOB,
  FINISH_JOB,
  RENEW_JOB,
  useCase,
  type ClaimJob,
  type ClaimJobArgs,
  type FinishJob,
  type FinishJobArgs,
  type RenewJob,
  type RenewJobArgs,
} from "@/application/use-cases/contracts";
import type { JobRow } from "@/db/repositories";

@useCase(CLAIM_JOB)
export class LocalClaimJob implements ClaimJob {
  constructor(private readonly runs: AgentRunService) {}

  invoke(args: ClaimJobArgs): Promise<JobRow | null> {
    return Promise.resolve(this.runs.claim(args.kinds, args.owner));
  }
}

@useCase(RENEW_JOB)
export class LocalRenewJob implements RenewJob {
  constructor(private readonly runs: AgentRunService) {}

  invoke(args: RenewJobArgs): Promise<boolean> {
    return Promise.resolve(this.runs.renew(args.id, args.owner));
  }
}

@useCase(FINISH_JOB)
export class LocalFinishJob implements FinishJob {
  constructor(private readonly runs: AgentRunService) {}

  invoke(args: FinishJobArgs): Promise<boolean> {
    return this.runs.finish(args.id, args.owner, args.report);
  }
}
