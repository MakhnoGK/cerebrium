// Distinct from a capability denial: the principal is permitted to make this call, just
// not this many of them yet. Retryable, and the message says when.
export class QuotaExceededError extends Error {
  constructor(
    readonly principal: string,
    readonly limit: string,
    readonly retryAfterMs: number,
  ) {
    super(
      `principal "${principal}" is over its ${limit} quota. ` +
        `Retry in about ${String(Math.ceil(retryAfterMs / 1000))}s — the call was refused before it ran.`,
    );
    this.name = "QuotaExceededError";
  }
}
