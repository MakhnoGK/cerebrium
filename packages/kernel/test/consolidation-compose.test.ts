import { describe, expect, it } from "vitest";
import {
  anchorsOf,
  composeDistill,
  composeMerge,
  missingAnchors,
  summaryOf,
} from "@/consolidation/compose";

const KEEP = {
  title: "Deploy",
  content: "Deploys go through CI.\n\n## Steps\n- build\n- push\n\n## Notes\nRun it at night.\n",
};
const DUP = { title: "Deploy (copy)", content: "" };

describe("Merge composition (composeMerge)", () => {
  it("should return the kept record unchanged when nothing is added", () => {
    // When / Then
    expect(composeMerge(KEEP, DUP, [], [])).toBe(KEEP.content.trimEnd());
  });

  it("should place each addition at the end of the section it names", () => {
    // When
    const body = composeMerge(
      KEEP,
      DUP,
      [
        { section: "Steps", text: "- tag the release" },
        { section: "Notes", text: "Never on Fridays." },
      ],
      [],
    );

    // Then
    expect(body).toBe(
      "Deploys go through CI.\n\n## Steps\n- build\n- push\n- tag the release\n\n" +
        "## Notes\nRun it at night.\n\n- Never on Fridays.",
    );
  });

  it("should append unplaced additions under their own heading and conflicts after them", () => {
    // When
    const body = composeMerge(
      KEEP,
      DUP,
      [{ section: "", text: "rollback is `deploy.sh --undo`" }],
      ["night vs. morning"],
    );

    // Then
    expect(body).toMatch(
      /Run it at night\.\n\n## Merged from: Deploy \(copy\)\n- rollback is `deploy\.sh --undo`\n\n## Unresolved conflicts\n- night vs\. morning$/,
    );
  });

  it("should append to a record without headings as plain lines", () => {
    // When / Then
    expect(
      composeMerge({ title: "T", content: "One line." }, DUP, [{ section: "", text: "x" }], []),
    ).toBe("One line.\n\n- x");
  });

  it("should skip additions the kept record already says verbatim or that repeat", () => {
    // When / Then
    expect(
      composeMerge(
        KEEP,
        DUP,
        [
          { section: "Steps", text: "build" },
          { section: "", text: "a" },
          { section: "", text: "- a" },
        ],
        [],
      ),
    ).toBe(`${KEEP.content.trimEnd()}\n\n## Merged from: Deploy (copy)\n- a`);
  });

  it("should not take a heading inside a code fence for a section", () => {
    // Given
    const keep = { title: "T", content: "Intro.\n\n```\n# not a heading\n```" };

    // When / Then
    expect(composeMerge(keep, DUP, [{ section: "not a heading", text: "x" }], [])).toBe(
      "Intro.\n\n```\n# not a heading\n```\n\n- x",
    );
  });
});

describe("Distill composition (composeDistill)", () => {
  it("should list each distinct fact once under the summary", () => {
    // When / Then
    expect(composeDistill("Summary.", ["a", "- b", "a", " "])).toBe("Summary.\n\n- a\n- b");
  });
});

describe("Summary line (summaryOf)", () => {
  it("should take the first line that is not a heading", () => {
    // When / Then
    expect(summaryOf("## Head\n\n- first fact\nsecond")).toBe("first fact");
  });
});

describe("Anchors (anchorsOf / missingAnchors)", () => {
  it("should find links, ids, URLs, numbers and code spans", () => {
    // When
    const anchors = anchorsOf(
      "See [[Deploy notes]] and 01M3V0833AGBMG5DXCX06PECN2 at https://x.dev/a, " +
        "took 61.8 s on 2026-08-04 with `think: false`.",
    );

    // Then
    expect(anchors).toEqual(
      expect.arrayContaining([
        "[[Deploy notes]]",
        "01M3V0833AGBMG5DXCX06PECN2",
        "https://x.dev/a",
        "61.8",
        "2026-08-04",
        "think: false",
      ]),
    );
  });

  it("should report only the anchors the draft does not carry", () => {
    // When / Then
    expect(missingAnchors(["ids 01M3V0833AGBMG5DXCX06PECN2 and `a.ts`"], "kept a.ts")).toEqual([
      "01M3V0833AGBMG5DXCX06PECN2",
    ]);
  });
});
