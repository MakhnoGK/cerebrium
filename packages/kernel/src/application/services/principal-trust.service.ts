import { inject, injectable } from "tsyringe";
import type { Authority } from "@cerebrium/contracts/types";
import { NODES_REPO_TOKEN, type NodesRepo } from "@/domain/ports/storage";
import { PrincipalPolicyService } from "@/application/services/principal-policy.service";

// Applies a principal's trust weight to what it wrote, at read time rather than write
// time — which is what makes it reversible: the nodes are untouched, only their standing
// in a ranking changes, and restoring the weight restores them.
@injectable()
export class PrincipalTrustService {
  constructor(
    private readonly policy: PrincipalPolicyService,
    @inject(NODES_REPO_TOKEN) private readonly nodes: NodesRepo,
  ) {}

  // A node is worth no more than the weakest principal behind its text: its writer, any
  // reviser, and whatever it was distilled from or superseded. Only nodes below neutral
  // are returned. Empty when no principal is weighted, and the caller then skips the
  // multiply entirely — a search must not pay a join for a no-op.
  async factors(ids: string[]): Promise<Map<string, Authority>> {
    if (!this.policy.hasWeights()) return new Map();

    const factors = new Map<string, Authority>();

    for (const [id, principals] of await this.nodes.originPrincipalsOf(ids)) {
      let weakest: Authority | undefined;

      for (const principal of principals) {
        const weight = this.policy.weightFor(principal);

        if (!weakest || weight < weakest.weight) weakest = { weight, weakest: principal };
      }

      if (weakest && weakest.weight !== 1) factors.set(id, weakest);
    }

    return factors;
  }
}

// A revoked principal's nodes are dropped from the result rather than scored to zero: a
// zero score still sorts, and in a result set where everything scored zero it would
// surface anyway.
export function isRevoked(authority: Authority | undefined): boolean {
  return authority?.weight === 0;
}
