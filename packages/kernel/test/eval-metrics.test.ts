import { pairedBootstrap } from "@scripts/metrics";
import { describe, expect, it } from "vitest";

describe("pairedBootstrap", () => {
  it("should report no difference between identical arms", () => {
    // Given
    const scores = [0.2, 0.5, 1, 0, 0.7];

    // When
    const band = pairedBootstrap(scores, [...scores]);

    // Then
    expect(band).toEqual({ delta: 0, low: 0, high: 0 });
  });

  it("should put a band around a noisy difference that straddles zero", () => {
    // Given
    const a = [1, 0, 1, 0, 1, 0, 1, 0];
    const b = [0, 1, 1, 0, 0, 1, 1, 0];

    // When
    const band = pairedBootstrap(a, b);

    // Then
    expect(band.delta).toBe(0);
    expect(band.low).toBeLessThan(0);
    expect(band.high).toBeGreaterThan(0);
  });

  it("should print the same band on a re-run", () => {
    // Given
    const a = [0.1, 0.4, 0.9, 0.3, 0.6, 0.2];
    const b = [0.3, 0.4, 0.7, 0.6, 0.8, 0.1];

    // When / Then
    expect(pairedBootstrap(a, b)).toEqual(pairedBootstrap(a, b));
  });

  it("should refuse arms scored on different query sets", () => {
    expect(() => pairedBootstrap([1, 0], [1])).toThrow();
  });
});
