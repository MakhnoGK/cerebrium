import { coverage, inventedNumbers, jaccard, percentile, terms } from "@scripts/role-metrics";
import { describe, expect, it } from "vitest";
import type { AnnotateResult } from "@/domain/ports/consolidation-provider";

function annotation(over: Partial<AnnotateResult> = {}): AnnotateResult {
  return { keywords: ["failover", "standby"], tags: ["resilience"], context: "c", ...over };
}

describe("Attribute coverage", () => {
  it("should score a candidate on what it reproduces, not on what it adds", () => {
    // Given — the candidate keeps both reference terms and adds two of its own.
    const reference = new Set(["failover", "standby"]);
    const other = new Set(["failover", "standby", "retry", "backoff"]);

    // When / Then — full coverage, while Jaccard reads the extras as disagreement.
    expect(coverage(reference, other)).toBe(1);
    expect(jaccard(reference, other)).toBe(0.5);
  });

  it("should count a missing term against the candidate", () => {
    // When / Then
    expect(coverage(new Set(["a", "b"]), new Set(["a"]))).toBe(0.5);
    expect(coverage(new Set(["a", "b"]), new Set())).toBe(0);
  });

  it("should treat an empty reference as covered rather than as a division by zero", () => {
    // When / Then
    expect(coverage(new Set(), new Set(["a"]))).toBe(1);
    expect(jaccard(new Set(), new Set())).toBe(1);
  });

  it("should fold keywords and tags into one case-insensitive set", () => {
    // When / Then
    expect(terms(annotation({ keywords: [" Failover "], tags: ["Resilience"] }))).toEqual(
      new Set(["failover", "resilience"]),
    );
  });
});

describe("Invented numbers", () => {
  const record = { title: "Failover behavior", content: "switches after 30 seconds" };

  it("should pass a number the record actually states", () => {
    // When / Then
    expect(inventedNumbers(annotation({ keywords: ["30 seconds"] }), record)).toBe(0);
  });

  it("should flag a digit string the record never mentions", () => {
    // When / Then
    expect(inventedNumbers(annotation({ keywords: ["2026 rollout", "45s timeout"] }), record)).toBe(
      2,
    );
  });

  it("should ignore single digits, which are too common to mean anything", () => {
    // When / Then
    expect(inventedNumbers(annotation({ tags: ["v9"] }), record)).toBe(0);
  });
});

describe("Percentiles", () => {
  it("should report the median of an unsorted sample and 0 for an empty one", () => {
    // When / Then
    expect(percentile([9, 1, 5], 0.5)).toBe(5);
    expect(percentile([], 0.5)).toBe(0);
  });
});
