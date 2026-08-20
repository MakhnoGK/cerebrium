import { injectable } from "tsyringe";
import { PrincipalPolicyService } from "@/application/services/principal-policy.service";
import { NodesRepo } from "@/db/repositories";

// Applies a principal's trust weight to what it wrote, at read time rather than write
// time — which is what makes it reversible: the nodes are untouched, only their standing
// in a ranking changes, and restoring the weight restores them.
@injectable()
export class PrincipalTrustService {
  constructor(
    private readonly policy: PrincipalPolicyService,
    private readonly nodes: NodesRepo,
  ) {}

  // Empty when no principal is weighted, and the caller then skips the multiply entirely.
  // That is the common case, and a search must not pay a join for a no-op.
  factors(ids: string[]): Map<string, number> {
    if (!this.policy.hasWeights()) return new Map();

    const factors = new Map<string, number>();

    for (const [id, principal] of this.nodes.principalsOf(ids)) {
      const weight = this.policy.weightFor(principal);

      if (weight !== 1) factors.set(id, weight);
    }

    return factors;
  }
}

// A revoked principal's nodes are dropped from the result rather than scored to zero: a
// zero score still sorts, and in a result set where everything scored zero it would
// surface anyway.
export function isRevoked(factor: number | undefined): boolean {
  return factor === 0;
}
