import { deriveSummary } from "@cerebrium/contracts/types";

export enum LintRule {
  TITLE_LONG = "title_long",
  TITLE_LABEL = "title_label",
  SUMMARY_NOT_STANDALONE = "summary_not_standalone",
  RELATIVE_DATE = "relative_date",
}

export interface LintFinding {
  rule: LintRule;
  message: string;
}

const TITLE_MAX = 100;
const SUMMARY_MIN = 40;
const LABEL_MIN_WORDS = 3;
const LABEL_CAPITALISED_SHARE = 0.75;

const DANGLING_OPENER =
  /^(this|that|it|these|those|they|see|above|below|here|это|этот|эта|он|она|оно|они|см\.?)(?![\p{L}])/iu;
const RELATIVE_DATE =
  /(?<![\p{L}])(today|yesterday|tomorrow|tonight|this week|last week|next week|сегодня|вчера|завтра|позавчера|на этой неделе|на прошлой неделе)(?![\p{L}])/iu;
const ABSOLUTE_DATE = /\d{4}-\d{2}-\d{2}/;

// "Cerebrium Technical Fixes and Architectural Constraints" names a topic; a sentence-case
// title with a colon or a lowercase run states a fact.
function readsAsLabel(title: string): boolean {
  if (title.includes(":")) return false;

  const words = title.split(/\s+/).filter((w) => /^\p{L}/u.test(w) && w.length > 3);

  if (words.length < LABEL_MIN_WORDS) return false;

  const capitalised = words.filter((w) => /^\p{Lu}/u.test(w)).length;

  return capitalised / words.length >= LABEL_CAPITALISED_SHARE;
}

export function lintWrite(draft: { title: string; content: string }): LintFinding[] {
  const findings: LintFinding[] = [];
  const title = draft.title.trim();
  const summary = deriveSummary(draft.content);

  if (title.length > TITLE_MAX) {
    findings.push({
      rule: LintRule.TITLE_LONG,
      message: `Title is ${String(title.length)} chars; keep the fact itself under ~${String(TITLE_MAX)} and move the rest into the body.`,
    });
  }

  if (readsAsLabel(title)) {
    findings.push({
      rule: LintRule.TITLE_LABEL,
      message: "Title reads as a topic label; state the fact it records in one line.",
    });
  }

  if (summary.length < SUMMARY_MIN || DANGLING_OPENER.test(summary) || summary.startsWith("[[")) {
    findings.push({
      rule: LintRule.SUMMARY_NOT_STANDALONE,
      message:
        "First line does not stand on its own; it becomes the summary every search shows, so make it one self-contained sentence.",
    });
  }

  const text = `${title}\n${draft.content}`;
  const relative = RELATIVE_DATE.exec(text);

  if (relative && !ABSOLUTE_DATE.test(text)) {
    findings.push({
      rule: LintRule.RELATIVE_DATE,
      message: `"${relative[1]!}" has no absolute date next to it; a later reader cannot tell when that was.`,
    });
  }

  return findings;
}
