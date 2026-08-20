import { injectable } from "tsyringe";
import { Capability, Posture, principalIdOf } from "@/core/vocab";
import {
  NEUTRAL_WEIGHT,
  PrincipalsConfig,
  type PrincipalProfile,
  type PrincipalQuota,
} from "@/infrastructure/config";

// Resolves what a principal may do. The profile named for that principal wins per
// capability, the default profile fills the gaps, and an unnamed capability is `auto` —
// so adding this changed nothing for a deployment that configures no principals.
@injectable()
export class PrincipalPolicyService {
  constructor(private readonly config: PrincipalsConfig) {}

  principalOf(client: string | null): string {
    return principalIdOf(client);
  }

  postureFor(principal: string, capability: Capability): Posture {
    const named: PrincipalProfile | undefined = this.config.profiles[principal];

    return (
      named?.capabilities[capability] ??
      this.config.default.capabilities[capability] ??
      Posture.AUTO
    );
  }

  // Taken whole rather than merged field by field: a named principal's quota replaces the
  // default, so raising one limit for a writer does not silently inherit the other.
  quotaFor(principal: string): PrincipalQuota {
    return this.config.profiles[principal]?.quota ?? this.config.default.quota;
  }

  weightFor(principal: string): number {
    return this.config.profiles[principal]?.weight ?? this.config.default.weight;
  }

  // False for a deployment that weights nobody, which is what lets retrieval skip the
  // node-to-principal lookup entirely instead of paying for a no-op on every search.
  hasWeights(): boolean {
    return (
      this.config.default.weight !== NEUTRAL_WEIGHT ||
      Object.values(this.config.profiles).some((profile) => profile.weight !== NEUTRAL_WEIGHT)
    );
  }
}
