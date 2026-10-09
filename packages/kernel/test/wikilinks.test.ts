import { describe, expect, it } from "vitest";
import {
  resolveTarget,
  rewriteWikilink,
  slugify,
  wikilinks,
  wikilinkTargets,
  type SlugIndex,
} from "@/core/wikilinks";

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

  it("should skip a link shown inside inline code or a fenced block", () => {
    // Given
    const content = "write `[[retry-budget]]`, then\n```\n[[kafka-topics]]\n```\nsee [[real-node]]";

    // When / Then
    expect(wikilinkTargets(content)).toEqual(["real-node"]);
  });

  it("should skip placeholder syntax written about links", () => {
    // Given
    const content = "rewritten to [[id]], [[ULID]], [[<id>]], [[x]], [[01M3…]] or [[...]]";

    // When / Then
    expect(wikilinkTargets(content)).toEqual([]);
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
    expect(resolveTarget(two, "alpha-node")).toEqual({ kind: "ambiguous", ids: ["A", "B"] });
  });

  it("should refuse to guess between two nodes sharing a title", () => {
    // Given / When / Then
    expect(resolveTarget(index([["alpha-node", ["A", "B"]]]), "alpha-node")).toEqual({
      kind: "ambiguous",
      ids: ["A", "B"],
    });
  });

  it("should report a target that matches nothing", () => {
    // Given / When / Then
    expect(resolveTarget(index([["alpha-node", ["A"]]]), "gamma")).toEqual({ kind: "unknown" });
  });

  it("should take a one-word link only as a whole title", () => {
    // Given
    const titles = index([
      ["idea-sync-call-prompt-advisor", ["A"]],
      ["roadmap", ["B"]],
    ]);

    // When / Then
    expect(resolveTarget(titles, "idea")).toEqual({ kind: "unknown" });
    expect(resolveTarget(titles, "roadmap")).toEqual({ kind: "exact", id: "B" });
  });

  it("should take a prefix only where a word of the title ends", () => {
    // Given / When / Then
    expect(resolveTarget(index([["alpha-nodes-list", ["A"]]]), "alpha-node")).toEqual({
      kind: "unknown",
    });
  });
});

describe("wikilinks", () => {
  it("should keep the link as written beside its slug, once per slug", () => {
    // Given
    const body = "see [[Retry Budget]] and [[retry budget|the budget]] and [[Kafka#Topics]]";

    // When / Then
    expect(wikilinks(body)).toEqual([
      { raw: "Retry Budget", slug: "retry-budget" },
      { raw: "Kafka", slug: "kafka" },
    ]);
  });
});

describe("rewriteWikilink", () => {
  it("should point every spelling of the link at the target and keep section and label", () => {
    // Given
    const body =
      "[[Retry Budget]], [[retry budget#Limits]] and [[Retry budget|the budget]]; [[Kafka]]";

    // When
    const out = rewriteWikilink(body, "Retry Budget", "01M3Y0PABXG69N9ENZFCB9D8QS");

    // Then
    expect(out).toEqual({
      content:
        "[[01M3Y0PABXG69N9ENZFCB9D8QS]], [[01M3Y0PABXG69N9ENZFCB9D8QS#Limits]] and " +
        "[[01M3Y0PABXG69N9ENZFCB9D8QS|the budget]]; [[Kafka]]",
      count: 3,
    });
  });

  it("should leave the label or the link text when unlinking", () => {
    // Given
    const body = "[[Retry Budget]] and [[Retry Budget|the budget]]";

    // When / Then
    expect(rewriteWikilink(body, "Retry Budget", null)).toEqual({
      content: "Retry Budget and the budget",
      count: 2,
    });
  });

  it("should leave a link shown as code untouched", () => {
    // Given
    const body = "`[[Retry Budget]]` is the syntax; [[Retry Budget]] is the link";

    // When / Then
    expect(rewriteWikilink(body, "Retry Budget", null)).toEqual({
      content: "`[[Retry Budget]]` is the syntax; Retry Budget is the link",
      count: 1,
    });
  });

  it("should report nothing rewritten when the link is gone", () => {
    expect(rewriteWikilink("no links here", "Retry Budget", null)).toEqual({
      content: "no links here",
      count: 0,
    });
  });
});
