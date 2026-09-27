// Rough token estimator: ~4 chars per token. Good enough for budgeting; the
// consumer is an LLM context window, not a billing meter.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateTokensOf(value: unknown): number {
  return estimateTokens(typeof value === "string" ? value : JSON.stringify(value));
}
