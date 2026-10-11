import { LintRule, lintWrite } from "@scripts/write-lint";
import { describe, expect, it } from "vitest";

const GOOD_BODY =
  "The sweep rewrites a survivor's body under its own principal, so authority must follow revisions.";

function rules(title: string, content = GOOD_BODY): LintRule[] {
  return lintWrite({ title, content }).map((finding) => finding.rule);
}

describe("lintWrite", () => {
  it("should pass a fact-shaped title with a standalone first line", () => {
    // Given / When / Then
    expect(rules("FIXED 2026-10-03: merge bodies were capped by a 2-4 sentence prompt")).toEqual(
      [],
    );
  });

  it("should flag a title over the length budget", () => {
    // Given
    const title = `Retrieval regression: ${"x".repeat(100)}`;

    // When / Then
    expect(rules(title)).toContain(LintRule.TITLE_LONG);
  });

  it.each([
    "Cerebrium Technical Fixes and Architectural Constraints",
    "Agent.documents Execution Logs Overview",
    "Архитектура Хранилища Памяти Агента",
  ])("should flag the topic label %s", (title) => {
    // Given / When / Then
    expect(rules(title)).toContain(LintRule.TITLE_LABEL);
  });

  it.each([
    "the sweep only links notes within one project family",
    "GOTCHA: sigma v3 draws rgba colours lighter than the canvas",
    "Phase 9",
  ])("should not flag %s as a label", (title) => {
    // Given / When / Then
    expect(rules(title)).not.toContain(LintRule.TITLE_LABEL);
  });

  it.each([
    "This is what we decided after the long review of the merge queue.",
    "See the parent note for the full context of this decision and more.",
    "[[01M3GHPZ4NJ0GC1WNY9TRB1BAJ]] covers the rest of the reasoning here.",
    "Short line.",
    "## Only a heading",
  ])("should flag a first line that does not stand alone: %s", (content) => {
    // Given / When / Then
    expect(rules("merge bodies were capped by the prompt", content)).toContain(
      LintRule.SUMMARY_NOT_STANDALONE,
    );
  });

  it("should not mistake a word that starts like an opener for one", () => {
    // Given
    const content = "Thistle is the codename of the second embedding space, built on 2026-10-03.";

    // When / Then
    expect(rules("embedding space codename", content)).not.toContain(
      LintRule.SUMMARY_NOT_STANDALONE,
    );
  });

  it.each([
    "We merged the fix today and the sweep has been quiet since then.",
    "Вчера откатили релиз, потому что миграция упала на хосте целиком.",
  ])("should flag a relative date with no absolute one: %s", (content) => {
    // Given / When / Then
    expect(rules("release rolled back after a failed migration", content)).toContain(
      LintRule.RELATIVE_DATE,
    );
  });

  it("should accept a relative date anchored by an absolute one", () => {
    // Given
    const content = "Merged on 2026-10-11; the sweep has been quiet since today's release.";

    // When / Then
    expect(rules("release went out without incident", content)).not.toContain(
      LintRule.RELATIVE_DATE,
    );
  });

  it("should not read a relative-date word inside another word", () => {
    // Given
    const content = "The todayStats helper aggregates per-day counts for the dashboard tiles.";

    // When / Then
    expect(rules("dashboard tiles aggregate per day", content)).not.toContain(
      LintRule.RELATIVE_DATE,
    );
  });
});
