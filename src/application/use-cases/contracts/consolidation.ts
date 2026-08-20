import type { ConsolidationRecommendation } from "@/domain/ports/consolidation-provider";
import { useCaseToken, type UseCase } from "@/application/use-cases/contracts/use-case";
import type { ConsolidationCandidate } from "@/core/types";
import type { ConsolidationKind, ConsolidationStatus } from "@/core/vocab";

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

export interface SuggestCandidatesArgs {
  kind?: ConsolidationKind;
  limit?: number;
}

export interface SuggestCandidatesResult {
  candidates: ConsolidationCandidate[];
}

export type SuggestCandidates = UseCase<SuggestCandidatesArgs, SuggestCandidatesResult>;

export const SUGGEST_CANDIDATES = useCaseToken<SuggestCandidatesArgs, SuggestCandidatesResult>(
  "SuggestCandidates",
);

export interface CandidateOverride {
  title: string;
  summary: string;
  body: string;
}

export interface ApplyCandidateArgs {
  session_id: string;
  id: string;
  decision: ConsolidationRecommendation;
  override?: CandidateOverride;
  collapse?: boolean;
}

export interface ApplyCandidateResult {
  id: string;
  status: ConsolidationStatus;
  kind: ConsolidationKind;
}

export type ApplyCandidate = UseCase<ApplyCandidateArgs, ApplyCandidateResult>;

export const APPLY_CANDIDATE = useCaseToken<ApplyCandidateArgs, ApplyCandidateResult>(
  "ApplyCandidate",
);
