import { describe, expect, it } from "vitest";
import { resolveTarget, slugify, wikilinkTargets, type SlugIndex } from "@/core/wikilinks";

function index(entries: [string, string[]][]): SlugIndex {
  return new Map(entries);
}

describe("slugify", () => {
  it("should collapse every run of non-alphanumerics to one hyphen", () => {
    // Given / When / Then
    expect(slugify("MEASURED 2026-08-21: the sweep's cost — twice!")).toBe(
      "measured-2026-08-21-the-sweep-s-cost-twice",
    );
  });

  it("should leave nothing to trim at either end", () => {
    // Given / When / Then
    expect(slugify("  ...Trailing punctuation!!  ")).toBe("trailing-punctuation");
  });
});

describe("wikilinkTargets", () => {
  it("should find every target once, in the order it first appears", () => {
    // Given
    const content = "see [[Beta Node]] and [[Alpha Node]], then [[beta-node]] again";

    // When / Then
    expect(wikilinkTargets(content)).toEqual(["beta-node", "alpha-node"]);
  });

  it("should stop at an alias or a heading marker", () => {
    // Given / When / Then
    expect(wikilinkTargets("[[some-node|shown text]] and [[other-node#section]]")).toEqual([
      "some-node",
      "other-node",
    ]);
  });

  it("should drop a link with nothing nameable in it", () => {
    // Given / When / Then
    expect(wikilinkTargets("empty [[ ]] and [[]] and [[---]]")).toEqual([]);
  });
});

describe("resolveTarget", () => {
  it("should take an exact title match", () => {
    // Given / When / Then
    expect(resolveTarget(index([["alpha-node", ["A"]]]), "alpha-node")).toEqual({
      kind: "exact",
      id: "A",
    });
  });

  it("should take a unique prefix, which is what a truncated slug is", () => {
    // Given / When / Then
    expect(resolveTarget(index([["alpha-node-with-a-long-tail", ["A"]]]), "alpha-node")).toEqual({
      kind: "prefix",
      id: "A",
    });
  });

  it("should refuse to guess between two prefix candidates", () => {
    // Given
    const two = index([
      ["alpha-node-one", ["A"]],
      ["alpha-node-two", ["B"]],
    ]);

    // When / Then
    expect(resolveTarget(two, "alpha-node")).toEqual({ kind: "ambiguous" });
  });

  it("should refuse to guess between two nodes sharing a title", () => {
    // Given / When / Then
    expect(resolveTarget(index([["alpha-node", ["A", "B"]]]), "alpha-node")).toEqual({
      kind: "ambiguous",
    });
  });

  it("should report a target that matches nothing", () => {
    // Given / When / Then
    expect(resolveTarget(index([["alpha-node", ["A"]]]), "gamma")).toEqual({ kind: "unknown" });
  });
});
