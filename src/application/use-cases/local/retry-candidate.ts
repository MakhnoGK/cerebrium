import {
  RETRY_CANDIDATE,
  useCase,
  type RetryCandidate,
  type RetryCandidateArgs,
  type RetryCandidateResult,
} from "@/application/use-cases/contracts";
import { ConsolidationRepo } from "@/db/repositories";

@useCase(RETRY_CANDIDATE)
export class LocalRetryCandidate implements RetryCandidate {
  constructor(private readonly consolidation: ConsolidationRepo) {}

  invoke({ id }: RetryCandidateArgs): Promise<RetryCandidateResult> {
    this.consolidation.clearCandidateProposal(id, null);
    this.consolidation.reopenCandidate(id);

    return Promise.resolve({ status: "reopened", id });
  }
}
