import { inject, injectable } from "tsyringe";
import { Capability, Posture } from "@cerebrium/contracts/vocab";
import { REVIEWS_REPO_TOKEN, type ReviewScope, type ReviewsRepo } from "@/domain/ports/storage";
import { PrincipalsConfig } from "@/infrastructure/config";

// Who is under review, and how much of their work is waiting.
//
// Derived from the same config the pipeline authorizes against, so the queue cannot drift
// from the postures actually in force. There is no table of principals to enumerate — only
// the ones config names — which is why a deployment whose DEFAULT posture is `suggest` is
// expressed as "everyone except these" rather than as a list.
@injectable()
export class ReviewService {
  constructor(
    private readonly config: PrincipalsConfig,
    @inject(REVIEWS_REPO_TOKEN) private readonly reviews: ReviewsRepo,
  ) {}

  scope(): ReviewScope {
    const named = Object.entries(this.config.profiles);
    const fallback = this.config.default.capabilities[Capability.WRITE] ?? Posture.AUTO;

    if (fallback === Posture.SUGGEST) {
      return {
        mode: "except",
        principals: named
          .filter(
            ([, p]) => (p.capabilities[Capability.WRITE] ?? Posture.SUGGEST) !== Posture.SUGGEST,
          )
          .map(([id]) => id),
      };
    }

    return {
      mode: "only",
      principals: named
        .filter(([, p]) => p.capabilities[Capability.WRITE] === Posture.SUGGEST)
        .map(([id]) => id),
    };
  }

  // True when no principal writes under `suggest`, so callers can skip the queue queries
  // entirely rather than pay for two counts that are structurally zero.
  reviewsNobody(): boolean {
    const scope = this.scope();

    return scope.mode === "only" && scope.principals.length === 0;
  }

  async pending(): Promise<{ edges: number; nodes: number; total: number }> {
    if (this.reviewsNobody()) return { edges: 0, nodes: 0, total: 0 };

    const counts = await this.reviews.pendingCount(this.scope());

    return { ...counts, total: counts.edges + counts.nodes };
  }
}
