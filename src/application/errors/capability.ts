import type { Capability } from "@/core/vocab";

// A principal is refused rather than failed: the message names who was refused and what
// for, because the caller cannot see the policy that produced it.
export class CapabilityDeniedError extends Error {
  constructor(
    readonly principal: string,
    readonly capability: Capability,
    readonly call: string,
  ) {
    super(
      `principal "${principal}" is not permitted to ${capability} (call: ${call}). ` +
        "This is policy, not a failure — the call was refused before it ran.",
    );
    this.name = "CapabilityDeniedError";
  }
}
