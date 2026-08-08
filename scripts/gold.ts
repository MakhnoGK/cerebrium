import { appendFileSync, existsSync, readFileSync } from "node:fs";

// The gold set: labelled queries for `eval:retrieval --db`, held as JSONL so a long
// generation run can append as it goes and resume after an interrupt.
//
// It is NOT checked into the repo. Labels are derived from a private store (work records,
// personal notes) and point at that store's ULIDs, so the real file lives beside the DB
// (`~/.cerebrium/gold.jsonl` by default) and only the machinery is versioned here.
//
// Three origins, because they carry different evidence:
//   generated   — a question written from one section of one node; the section is the gold.
//                 Cheap and broad, but synthetic phrasing skews lexical.
//   adjudicated — a real query from the retrieval-outcome log, with the nodes that actually
//                 answer it judged one by one. Realistic phrasing, multi-label.
//   mined       — implicit: within one session a `get` after a `search` that returned the
//                 node. Free, and biased toward whatever the incumbent ranker ranked first.

export const GOLD_ORIGINS = ["generated", "adjudicated", "mined"] as const;

export type GoldOrigin = (typeof GOLD_ORIGINS)[number];

export interface GoldEntry {
  query: string;
  gold: string[];
  origin: GoldOrigin;
  // Sections of a gold node that answer the query, when the label is that fine.
  sections?: Record<string, string[]>;
  // Where a generated question came from, kept so a bad prompt can be traced back.
  source?: { node: string; section?: string };
  model?: string;
  created?: string;
}

// One scored question, however its labels were produced.
export interface EvalQuery {
  query: string;
  gold: Set<string>;
  sections?: Map<string, Set<string>>;
  origins: Set<GoldOrigin>;
}

function isOrigin(value: unknown): value is GoldOrigin {
  return typeof value === "string" && (GOLD_ORIGINS as readonly string[]).includes(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

function parseSections(value: unknown): Record<string, string[]> | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  const out: Record<string, string[]> = {};

  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const names = strings(raw);

    if (names.length) out[id] = names;
  }

  return Object.keys(out).length ? out : undefined;
}

// Returns null rather than throwing: a run killed mid-write leaves a truncated last line,
// and one bad line must not cost the other few thousand.
export function parseGoldLine(line: string): GoldEntry | null {
  if (!line.trim()) return null;

  let raw: Record<string, unknown>;

  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  const query = typeof raw.query === "string" ? raw.query.trim() : "";
  const gold = strings(raw.gold);

  if (!query || !gold.length || !isOrigin(raw.origin)) return null;

  return {
    query,
    gold,
    origin: raw.origin,
    sections: parseSections(raw.sections),
    source:
      typeof raw.source === "object" && raw.source !== null ? (raw.source as never) : undefined,
    model: typeof raw.model === "string" ? raw.model : undefined,
    created: typeof raw.created === "string" ? raw.created : undefined,
  };
}

export function readGoldFile(path: string): { entries: GoldEntry[]; malformed: number } {
  if (!existsSync(path)) return { entries: [], malformed: 0 };

  const lines = readFileSync(path, "utf8").split("\n");
  const entries: GoldEntry[] = [];
  let malformed = 0;

  for (const line of lines) {
    if (!line.trim()) continue;

    const entry = parseGoldLine(line);

    if (entry) entries.push(entry);
    else malformed++;
  }

  return { entries, malformed };
}

export function appendGold(path: string, entries: GoldEntry[]): void {
  if (!entries.length) return;

  appendFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

// A label pointing at a node that has since been invalidated or merged away says nothing
// about today's ranking, and scoring it would count a correct ranking as a miss. Dropped
// labels are reported rather than silently swallowed — a large count means the gold set
// needs regenerating, which is a fact about the set, not a detail.
export function pruneStale(
  entries: GoldEntry[],
  isLive: (id: string) => boolean,
): { kept: GoldEntry[]; droppedLabels: number; droppedQueries: number } {
  const kept: GoldEntry[] = [];
  let droppedLabels = 0;
  let droppedQueries = 0;

  for (const entry of entries) {
    const gold = entry.gold.filter(isLive);

    droppedLabels += entry.gold.length - gold.length;

    if (!gold.length) {
      droppedQueries++;
      continue;
    }

    const sections = entry.sections
      ? Object.fromEntries(Object.entries(entry.sections).filter(([id]) => isLive(id)))
      : undefined;

    kept.push({ ...entry, gold, sections });
  }

  return { kept, droppedLabels, droppedQueries };
}

const normalize = (query: string): string => query.trim().toLowerCase().replace(/\s+/g, " ");

// One question asked twice — generated and then adjudicated, or mined in two sessions — is
// one query with the union of what each pass judged relevant. Merging rather than keeping
// duplicates matters for the metrics: the same query scored twice would weight itself twice
// in every mean.
export function toEvalQueries(entries: GoldEntry[]): EvalQuery[] {
  const byQuery = new Map<string, EvalQuery>();

  for (const entry of entries) {
    const key = normalize(entry.query);
    const existing = byQuery.get(key);
    const target = existing ?? {
      query: entry.query,
      gold: new Set<string>(),
      sections: new Map<string, Set<string>>(),
      origins: new Set<GoldOrigin>(),
    };

    for (const id of entry.gold) target.gold.add(id);

    target.origins.add(entry.origin);

    for (const [id, names] of Object.entries(entry.sections ?? {})) {
      const seen = target.sections?.get(id) ?? new Set<string>();

      for (const name of names) seen.add(name);
      target.sections?.set(id, seen);
    }

    if (!existing) byQuery.set(key, target);
  }

  return [...byQuery.values()];
}

export function filterByOrigin(entries: GoldEntry[], origins: Set<GoldOrigin>): GoldEntry[] {
  return origins.size ? entries.filter((e) => origins.has(e.origin)) : entries;
}

export function parseOrigins(raw: string | undefined): Set<GoldOrigin> {
  const wanted = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(isOrigin);

  return new Set(wanted);
}

export function countByOrigin(entries: GoldEntry[]): Record<GoldOrigin, number> {
  const counts = { generated: 0, adjudicated: 0, mined: 0 };

  for (const entry of entries) counts[entry.origin]++;

  return counts;
}

const STOPWORDS = new Set(
  (
    "the and for that this with from what when which where how why does did are was were has " +
    "have had its not but can could should would will into than then there their who whom " +
    "about after before between under over only also any all one two because"
  ).split(" "),
);

export function contentWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

  return new Set(words);
}

// Share of a question's content words that appear verbatim in the section it was written
// from. A question that echoes its source scores near 1 and is worthless as a label: it
// hands BM25 the answer and never asks the vector side to bridge any vocabulary at all —
// which is precisely the side the uncalibrated constants govern.
export function lexicalOverlap(question: string, section: string): number {
  const asked = contentWords(question);

  if (!asked.size) return 1;

  const source = contentWords(section);
  let shared = 0;

  for (const word of asked) if (source.has(word)) shared++;

  return shared / asked.size;
}
