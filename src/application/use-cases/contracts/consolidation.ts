import { useCaseToken, type UseCase } from "@/application/use-cases/contracts/use-case";

export interface RetryCandidateArgs {
  id: string;
}

export interface RetryCandidateResult {
  status: "reopened";
  id: string;
}

export type RetryCandidate = UseCase<RetryCandidateArgs, RetryCandidateResult>;

export const RETRY_CANDIDATE = useCaseToken<RetryCandidateArgs, RetryCandidateResult>(
  "RetryCandidate",
);
