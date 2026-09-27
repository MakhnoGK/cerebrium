import "reflect-metadata";
import { appendGold, lexicalOverlap, readGoldFile, type GoldEntry } from "@scripts/gold";
import { chat, DEFAULT_MODEL, DEFAULT_URL, parseJsonObject } from "@scripts/model";
import type Database from "better-sqlite3";
import { DB_TOKEN } from "@/db/repositories/base";
import { buildContainer } from "@/container";
import { EnvConfigSource, LayeredConfigSource, StaticConfigSource } from "@/infrastructure/config";

// Manufactures the gold set `eval:retrieval --db` cannot mine. For each section of each
// live authored node it asks the local model for questions that section answers; the
// section is then the label. The store is opened READ-ONLY through the `cli` role — this
// writes nothing but the output file, which by design lives outside the repo.
//
// Resumable by construction: every section is appended as it completes, and a re-run skips
// the sections already present in the output.

const SYSTEM = `You write retrieval evaluation questions for an engineering memory system.
You are given one section of one note. Write questions whose answer is in that section.

Rules:
- Ask what an engineer would ask months later, having forgotten the wording.
- Paraphrase: prefer a natural synonym over the section's own distinctive nouns. Keep
  identifiers that have no synonym (file names, env vars, error codes).
- One self-contained question per item. No "in this section", no meta-questions.
- Reply with JSON only: {"questions": ["...", "..."]}`;

const HELP = `
gold-generate — manufacture labelled queries from the store's own sections.

  npm run gold:generate -- --db PATH --out PATH [options]

  --db PATH       Store to read. Opened READ-ONLY (cli role); never written.
  --out PATH      Gold JSONL to append to (default ~/.cerebrium/gold.jsonl). Existing
                  entries are read first, so an interrupted run resumes where it stopped.
  --per-section N Questions to ask per section (default 3).
  --limit N       Stop after N sections (default all).
  --project P     Only nodes of this project.
  --min-chars N   Skip sections shorter than this (default 200) — a two-line section
                  yields questions no ranking can distinguish.
  --max-overlap X Drop a question sharing more than this share of its content words with
                  its source section (default 0.8). A question that echoes its section
                  hands BM25 the answer and never exercises the vector side.
  --model M       Generation model (default ${DEFAULT_MODEL}).
  --url U         Chat endpoint (default ${DEFAULT_URL}).
  --timeout MS    Per-call timeout (default 120000).
  --dry-run       Print what would be generated (section inventory only), call nothing.
  --help          This text.

The output is NOT versioned: it is derived from one private store and points at that
store's ids. See scripts/gold.ts.
`;

interface Section {
  node: string;
  title: string;
  project: string | null;
  heading: string;
  text: string;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);

  return i >= 0 ? argv[i + 1] : undefined;
}

function num(argv: string[], name: string, fallback: number): number {
  const raw = arg(argv, name);
  const parsed = raw === undefined ? NaN : Number(raw);

  return Number.isFinite(parsed) ? parsed : fallback;
}

// The current revision of every live authored node, one row per section. Mirrors are
// excluded: code symbols and external records are derived, and a question about them
// measures the mirror pipeline rather than the memory.
function loadSections(db: Database.Database, project: string | undefined): Section[] {
  const rows = db
    .prepare(
      `WITH live AS (
         SELECT n.id, MAX(c.rev) AS rev
         FROM nodes n JOIN chunks c ON c.node_id = n.id
         WHERE n.invalidated_at IS NULL
           AND n.memory_kind IN ('semantic','episodic')
           AND (? IS NULL OR n.project = ?)
         GROUP BY n.id
       )
       SELECT c.node_id AS node, n.title, n.project,
              COALESCE(c.heading_path, '(preamble)') AS heading,
              c.text
       FROM chunks c
       JOIN live l ON l.id = c.node_id AND l.rev = c.rev
       JOIN nodes n ON n.id = c.node_id
       WHERE c.stale = 0
       ORDER BY c.node_id, c.seq`,
    )
    .all(project ?? null, project ?? null) as Section[];

  return rows;
}

function prompt(section: Section, perSection: number): string {
  return (
    `NOTE: ${section.title}\n` +
    `SECTION: ${section.heading}\n\n` +
    `${section.text}\n\n` +
    `Write ${String(perSection)} questions.`
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }

  const store = arg(argv, "--db");

  if (!store) {
    console.error("gold-generate: --db PATH is required (see --help)");
    process.exitCode = 1;
    return;
  }

  const out = arg(argv, "--out") ?? `${process.env.HOME ?? "."}/.cerebrium/gold.jsonl`;
  const perSection = num(argv, "--per-section", 3);
  const limit = num(argv, "--limit", Infinity);
  const minChars = num(argv, "--min-chars", 200);
  const maxOverlap = num(argv, "--max-overlap", 0.8);
  const model = arg(argv, "--model") ?? DEFAULT_MODEL;
  const url = arg(argv, "--url") ?? DEFAULT_URL;
  const timeoutMs = num(argv, "--timeout", 120_000);
  const project = arg(argv, "--project");

  const container = buildContainer({
    role: "cli",
    source: new LayeredConfigSource(
      new StaticConfigSource({ MEMORY_DB_PATH: store }),
      new EnvConfigSource(),
    ),
  });
  const db = container.resolve<Database.Database>(DB_TOKEN);
  const sections = loadSections(db, project).filter((s) => s.text.length >= minChars);
  const done = new Set(
    readGoldFile(out)
      .entries.filter((e) => e.source?.node)
      .map((e) => `${e.source!.node}|${e.source!.section ?? ""}`),
  );
  const pending = sections
    .filter((s) => !done.has(`${s.node}|${s.heading}`))
    .slice(0, Number.isFinite(limit) ? limit : undefined);

  console.log(`store: ${store} (read-only)`);
  console.log(
    `sections: ${String(sections.length)} eligible, ${String(done.size)} already generated, ${String(pending.length)} to do`,
  );

  if (argv.includes("--dry-run") || !pending.length) {
    console.log(`out: ${out}${pending.length ? " (nothing written: --dry-run)" : ""}`);
    return;
  }

  console.log(`model: ${model} at ${url}\nout: ${out}\n`);

  const started = Date.now();
  let kept = 0;
  let echoed = 0;
  let failed = 0;

  for (const [index, section] of pending.entries()) {
    let raw: string;

    try {
      raw = await chat(SYSTEM, prompt(section, perSection), { url, model, timeoutMs });
    } catch (err) {
      failed++;
      console.log(`  ! ${section.node} ${section.heading}: ${(err as Error).message}`);
      continue;
    }

    const parsed = parseJsonObject(raw);
    const questions = Array.isArray(parsed?.questions)
      ? parsed.questions.filter((q): q is string => typeof q === "string" && q.trim().length > 10)
      : [];

    if (!questions.length) {
      failed++;
      continue;
    }

    const entries: GoldEntry[] = [];

    for (const question of questions) {
      if (lexicalOverlap(question, section.text) > maxOverlap) {
        echoed++;
        continue;
      }

      entries.push({
        query: question.trim(),
        gold: [section.node],
        origin: "generated",
        sections: { [section.node]: [section.heading] },
        source: { node: section.node, section: section.heading },
        model,
        created: new Date().toISOString(),
      });
    }

    appendGold(out, entries);
    kept += entries.length;

    const n = index + 1;

    if (n % 25 === 0 || n === pending.length) {
      const elapsed = (Date.now() - started) / 1000;
      const rate = elapsed / n;

      console.log(
        `  ${String(n)}/${String(pending.length)} sections — ${String(kept)} questions kept, ` +
          `${String(echoed)} dropped as echoes, ${String(failed)} failures, ` +
          `${rate.toFixed(1)} s/section, ~${(((pending.length - n) * rate) / 60).toFixed(0)} min left`,
      );
    }
  }

  console.log(
    `\ndone: ${String(kept)} questions from ${String(pending.length)} sections ` +
      `(${String(echoed)} dropped as echoes, ${String(failed)} sections produced nothing)`,
  );
}

main().catch((e: unknown) => {
  console.error("gold-generate failed:", e);
  process.exit(1);
});
