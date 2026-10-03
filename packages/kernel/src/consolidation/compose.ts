// Builds the note body from a model's merge additions or distilled facts.

export interface MergeAddition {
  section: string;
  text: string;
}

export interface MergeSource {
  title: string;
  content: string;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s/;
const MAX_MISSING = 40;

interface Heading {
  line: number;
  level: number;
  text: string;
}

function headingsOf(lines: string[]): Heading[] {
  const out: Heading[] = [];
  let fenced = false;

  lines.forEach((line, i) => {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced) return;

    const m = HEADING.exec(line);
    if (m) out.push({ line: i, level: m[1]!.length, text: m[2]! });
  });

  return out;
}

export function sectionsOf(content: string): string[] {
  return [...new Set(headingsOf(content.split("\n")).map((h) => h.text))];
}

function stripMarker(text: string): string {
  return text.trim().replace(/^([-*+]|\d+[.)])\s+/, "");
}

function bullet(text: string): string {
  const t = stripMarker(text);

  return t.includes("\n") ? t : `- ${t}`;
}

function lastContentLine(lines: string[], from: number, to: number): number {
  for (let i = to - 1; i > from; i--) {
    if (lines[i]!.trim()) return i;
  }

  return from;
}

function sectionEnd(lines: string[], hs: Heading[], h: Heading): number {
  const next = hs.find((o) => o.line > h.line && o.level <= h.level);

  return lastContentLine(lines, h.line, next ? next.line : lines.length) + 1;
}

function block(lines: string[], at: number, items: string[]): string[] {
  const prev = lines[at - 1] ?? "";
  const continuesList = LIST_ITEM.test(prev);

  return continuesList ? items : ["", ...items];
}

export function composeMerge(
  keep: MergeSource,
  duplicate: MergeSource,
  additions: MergeAddition[],
  conflicts: string[],
): string {
  const lines = keep.content.replace(/\s+$/, "").split("\n");
  const hs = headingsOf(lines);
  const seen = new Set(lines.map(stripMarker).filter(Boolean));
  const bySection = new Map<string, string[]>();
  const tail: string[] = [];

  for (const a of additions) {
    const text = stripMarker(a.text);

    if (!text || seen.has(text)) continue;

    seen.add(text);

    const h = hs.find((o) => o.text === a.section.trim());

    if (h) {
      bySection.set(h.text, [...(bySection.get(h.text) ?? []), bullet(text)]);
    } else {
      tail.push(bullet(text));
    }
  }

  const inserts = [...bySection.entries()]
    .map(([section, items]) => {
      const h = hs.find((o) => o.text === section)!;

      return { at: sectionEnd(lines, hs, h), items };
    })
    .sort((a, b) => b.at - a.at);

  for (const { at, items } of inserts) {
    lines.splice(at, 0, ...block(lines, at, items));
  }

  if (tail.length) {
    if (hs.length) {
      lines.push("", `## Merged from: ${duplicate.title}`, ...tail);
    } else {
      lines.push(...block(lines, lines.length, tail));
    }
  }

  const disputes = [...new Set(conflicts.map(stripMarker).filter(Boolean))];

  if (disputes.length) {
    lines.push("", "## Unresolved conflicts", ...disputes.map((c) => `- ${c}`));
  }

  return lines.join("\n");
}

export function composeDistill(summary: string, facts: string[]): string {
  const items = [...new Set(facts.map(stripMarker).filter(Boolean))];
  const head = summary.trim();

  return [head, items.map((f) => (f.includes("\n") ? f : `- ${f}`)).join("\n")]
    .filter(Boolean)
    .join("\n\n");
}

export function summaryOf(body: string): string {
  const lines = body.split("\n").map((l) => l.trim());

  return stripMarker(lines.find((l) => l && !HEADING.test(l)) ?? "");
}

const ANCHORS = [
  /\[\[[^\]\n]+\]\]/g,
  /\b[0-7][0-9A-HJKMNP-TV-Z]{25}\b/g,
  /https?:\/\/[^\s)>\]`"']+/g,
  /\b\d[\d.,:/-]*\d%?(?!\w)/g,
];
const INLINE_CODE = /`([^`\n]{2,80})`/g;

export function anchorsOf(text: string): string[] {
  const out = new Set<string>();

  for (const re of ANCHORS) {
    for (const m of text.matchAll(re)) out.add(m[0].replace(/[.,:]+$/, ""));
  }

  for (const m of text.matchAll(INLINE_CODE)) out.add(m[1]!.trim());

  return [...out];
}

// Anchors the sources carry that the draft lost: ids, links, URLs, numbers and code spans.
export function missingAnchors(sources: string[], draft: string): string[] {
  const out = new Set<string>();

  for (const s of sources) {
    for (const a of anchorsOf(s)) {
      if (!draft.includes(a)) out.add(a);
    }
  }

  return [...out].slice(0, MAX_MISSING);
}
