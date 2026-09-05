import { useCaseToken, type UseCase } from "@/application/use-cases/contracts/use-case";
import type { ReviewArtifact, ReviewDecision } from "@/core/vocab";

// Reviewing what a `suggest`-posture principal wrote. The consolidation queue reviews
// PROPOSALS, which have not happened yet; this reviews writes that already landed, because
// `suggest` never blocked them — it let them through and marked the audit row.
//
// Both calls cost `consolidate`, not `write`. A principal at `write: suggest` therefore
// cannot clear its own queue: the capability that reviews is one its profile does not carry.

export interface ReviewNodeStub {
  id: string;
  type: string;
  title: string;
}

export interface ReviewItem {
  artifact: ReviewArtifact;
  // A node id, or `src|dst|type` for an edge. Pass it back to `resolve_review` verbatim.
  ref: string;
  principal: string | null;
  at: string;
  edge_type?: string;
  src?: ReviewNodeStub;
  dst?: ReviewNodeStub;
  node?: ReviewNodeStub;
}

export interface ListReviewsArgs {
  session_id?: string;
  artifact?: ReviewArtifact;
  limit?: number;
}

export interface ListReviewsResult {
  items: ReviewItem[];
  pending: { edges: number; nodes: number };
  // The principals whose writes land here, so a caller can tell an empty queue apart from
  // a deployment where nothing is under review at all.
  reviewing: { mode: "only" | "except"; principals: string[] };
}

export type ListReviews = UseCase<ListReviewsArgs, ListReviewsResult>;

export const LIST_REVIEWS = useCaseToken<ListReviewsArgs, ListReviewsResult>("ListReviews");

export interface ResolveReviewArgs {
  session_id: string;
  artifact: ReviewArtifact;
  ref: string;
  decision: ReviewDecision;
  note?: string;
}

export interface ResolveReviewResult {
  artifact: ReviewArtifact;
  ref: string;
  decision: ReviewDecision;
  // Whether this call actually retired something. False for `kept`, and false for an
  // `undone` whose artifact was already gone.
  undone: boolean;
}

export type ResolveReview = UseCase<ResolveReviewArgs, ResolveReviewResult>;

export const RESOLVE_REVIEW = useCaseToken<ResolveReviewArgs, ResolveReviewResult>("ResolveReview");
