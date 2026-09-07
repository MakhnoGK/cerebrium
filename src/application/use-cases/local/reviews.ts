import { inject } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { ReviewService } from "@/application/services/review.service";
import {
  LIST_REVIEWS,
  RESOLVE_REVIEW,
  useCase,
  type ListReviews,
  type ListReviewsArgs,
  type ListReviewsResult,
  type ResolveReview,
  type ResolveReviewArgs,
  type ResolveReviewResult,
  type ReviewItem,
} from "@/application/use-cases/contracts";
import { EdgesRepo, NodesRepo, SessionsRepo } from "@/db/repositories";
import { parseEdgeRef, ReviewsRepo } from "@/db/repositories/reviews";
import { ClientIdentity } from "@/runtime/client-identity";
import { EdgeType, principalIdOf, ReviewArtifact, ReviewDecision } from "@/core/vocab";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

@useCase(LIST_REVIEWS)
export class LocalListReviews implements ListReviews {
  constructor(
    private readonly service: ReviewService,
    private readonly reviews: ReviewsRepo,
  ) {}

  invoke(args: ListReviewsArgs): Promise<ListReviewsResult> {
    const scope = this.service.scope();
    const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const counts = this.service.pending();

    const answer = (items: ReviewItem[]): ListReviewsResult => ({
      items,
      pending: { edges: counts.edges, nodes: counts.nodes },
      reviewing: { mode: scope.mode, principals: [...scope.principals] },
    });

    if (this.service.reviewsNobody()) return Promise.resolve(answer([]));

    const wantEdges = args.artifact === undefined || args.artifact === ReviewArtifact.EDGE;
    const wantNodes = args.artifact === undefined || args.artifact === ReviewArtifact.NODE;

    const edges: ReviewItem[] = wantEdges
      ? this.reviews.pendingEdges(scope, limit).map((e) => ({
          artifact: ReviewArtifact.EDGE,
          ref: e.ref,
          principal: e.principal,
          at: e.at,
          edge_type: e.edge_type,
          src: e.src,
          dst: e.dst,
        }))
      : [];

    const nodes: ReviewItem[] = wantNodes
      ? this.reviews.pendingNodes(scope, limit).map((n) => ({
          artifact: ReviewArtifact.NODE,
          ref: n.ref,
          principal: n.principal,
          at: n.at,
          node: n.node,
        }))
      : [];

    // Newest first across both kinds, then cut to one page — otherwise a busy edge queue
    // would hide every node behind it.
    const items = [...edges, ...nodes].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);

    return Promise.resolve(answer(items));
  }
}

@useCase(RESOLVE_REVIEW)
export class LocalResolveReview implements ResolveReview {
  constructor(
    private readonly reviews: ReviewsRepo,
    private readonly edges: EdgesRepo,
    private readonly nodes: NodesRepo,
    private readonly sessions: SessionsRepo,
    private readonly identity: ClientIdentity,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async invoke(args: ResolveReviewArgs): Promise<ResolveReviewResult> {
    const now = this.clock.now();
    const undone = args.decision === ReviewDecision.UNDONE ? await this.undo(args, now) : false;

    this.reviews.record({
      artifact: args.artifact,
      ref: args.ref,
      decision: args.decision,
      decided_at: now,
      decided_by:
        this.sessions.principalOf(args.session_id) ?? principalIdOf(this.identity.get().client),
      note: args.note ?? null,
    });

    return { artifact: args.artifact, ref: args.ref, decision: args.decision, undone };
  }

  private async undo(args: ResolveReviewArgs, now: string): Promise<boolean> {
    if (args.artifact === ReviewArtifact.EDGE) {
      const edge = parseEdgeRef(args.ref);

      if (edge === null) {
        throw new Error(`${args.ref} is not an edge reference; expected src|dst|type`);
      }

      this.edges.invalidateEdge(edge.src, edge.dst, edge.type as EdgeType, now);

      return true;
    }

    // Already retired by someone else is not an error: the decision still needs recording,
    // and re-invalidating would move a timestamp that belongs to the first retirement.
    if (this.nodes.referenceState(args.ref) !== "live") return false;

    await Promise.resolve(
      this.nodes.invalidateNode(args.ref, { ts: now, session_id: args.session_id }),
    );

    return true;
  }
}
