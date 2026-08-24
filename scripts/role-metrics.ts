import type { AnnotateResult } from "@/domain/ports/consolidation-provider";

// The arithmetic behind `npm run eval:roles`, kept out of the runner so it can be tested
// without a model on the other end of a socket.

export const GATES = {
  // A candidate may not lose more than this much accuracy against the baseline.
  accuracyDrop: 0.05,
  // ...nor this much of the attributes the baseline finds, measured against how much of its
  // own the baseline reproduces on a second pass. A fixed number here would be a guess: no
  // model repeats its own keyword set exactly, so the floor has to come from the incumbent.
  coverageDrop: 0.1,
};

// How much of `reference` also appears in `other`. Directional on purpose: extra attributes
// are not a defect for a recall widener, missing ones are.
export function coverage(reference: Set<string>, other: Set<string>): number {
  if (!reference.size) return 1;

  return [...reference].filter((term) => other.has(term)).length / reference.size;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;

  const shared = [...a].filter((term) => b.has(term)).length;

  return shared / (a.size + b.size - shared);
}

// Digit strings the record does not contain. The annotate prompt forbids inventing numbers
// and dates, and a keyword carrying one the record never mentions is the cheapest possible
// evidence that a smaller model started filling gaps.
export function inventedNumbers(
  result: AnnotateResult,
  record: { title: string; content: string },
): number {
  const source = `${record.title}\n${record.content}`;

  return [...result.keywords, ...result.tags]
    .flatMap((term) => term.match(/\d{2,}/g) ?? [])
    .filter((digits) => !source.includes(digits)).length;
}

export function terms(result: AnnotateResult): Set<string> {
  return new Set([...result.keywords, ...result.tags].map((term) => term.trim().toLowerCase()));
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((total, x) => total + x, 0) / values.length : 0;
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;

  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}
