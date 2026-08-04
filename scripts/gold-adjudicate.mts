import "reflect-metadata";
import { readFileSync } from "node:fs";
import { appendGold, readGoldFile } from "@scripts/gold";
import { chat, DEFAULT_MODEL, DEFAULT_URL, parseJsonObject } from "@scripts/model";
import type Database from "better-sqlite3";
import { container as root } from "tsyringe";
import { HintsService } from "@/application/services";
import { DB_TOKEN } from "@/db/repositories/base";
import { SearchTool } from "@/presentation/mcp/tools/search";
import { buildContainer } from "@/container";
import { EnvConfigSource, LayeredConfigSource, StaticConfigSource } from "@/infrastructure/config";

// Turns real queries into multi-label gold. A generated question knows only the section it
// was written from, so every other node that also answers it scores as a ranking error;
// here each candidate is judged on its own and a query ends up with everything that answers
// it. The queries themselves come from the retrieval-outcome log — genuine recall
// situations, phrased as an agent actually phrased them, which no synthetic question is.
//
// Candidates are POOLED across retrieval modes (hybrid, text, vector) rather than taken
// from one ranking. Judging only what today's ranker returns would bake that ranker into
// the labels and make every future arm look like a regression; pooling across modes is the
// cheapest way to widen what gets seen. It does not remove the bias — a node no mode
// retrieves can still never be labelled.
//
// The store is opened READ-ONLY through the `cli` role and the session-hint write is
// stubbed out, exactly as `eval-retrieval --db` does.

const SYSTEM = `You judge whether a stored engineering note answers a question.

You are given a question and numbered candidate notes. Reply with the numbers of the notes
that genuinely answer the question — not those on a related topic, not those that merely
mention the same system. Zero, one, or several may qualify.

Reply with JSON only: {"answers": [1, 4]}`;

const HELP = `
gold-adjudicate — label real queries by judging each candidate on its own.

  npm run gold:adjudicate -- --db PATH [options]

  --db PATH     Store to read. Opened READ-ONLY (cli role); never written.
  --out PATH    Gold JSONL to append to (default ~/.cerebrium/gold.jsonl). Queries already
                adjudicated there are skipped, so an interrupted run resumes.
  --from S      Where the queries come from (default log):
                  log       distinct query strings from the retrieval-outcome log
                  gold      questions already in the gold file (upgrades a generated
                            single label to the full set of nodes that answer it)
                  FILE      a path: one query per line
  --limit N     Stop after N queries (default all).
  --pool N      Candidates per retrieval mode (default 10). Three modes are pooled.
  --excerpt N   Characters of each candidate shown to the judge (default 400).
  --model M     Judging model (default ${DEFAULT_MODEL}).
  --url U       Chat endpoint (default ${DEFAULT_URL}).
  --timeout MS  Per-call timeout (default 180000).
  --help        This text.
`;

interface Candidate {
  id: string;
  title: string;
  excerpt: string;
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

function queriesFromLog(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT json_extract(detail, '$.query') AS query
       FROM events
       WHERE action = 'search' AND json_extract(detail, '$.query') IS NOT NULL
       ORDER BY query`,
    )
    .all() as { query: string }[];

  return rows.map((r) => r.query).filter((q) => q.trim().length > 3);
}

// Title plus the opening of the current revision — enough for a judge to tell "answers it"
// from "same topic", without paying for whole bodies.
function excerpts(db: Database.Database, ids: string[], chars: number): Map<string, Candidate> {
  if (!ids.length) return new Map();

  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `WITH live AS (
         SELECT node_id, MAX(rev) AS rev FROM chunks WHERE node_id IN (${placeholders})
         GROUP BY node_id
       )
       SELECT c.node_id AS id, n.title, c.text, c.seq
       FROM chunks c
       JOIN live l ON l.node_id = c.node_id AND l.rev = c.rev
       JOIN nodes n ON n.id = c.node_id
       WHERE c.stale = 0
       ORDER BY c.node_id, c.seq`,
    )
    .all(...ids) as { id: string; title: string; text: string; seq: number }[];

  const out = new Map<string, Candidate>();

  for (const row of rows) {
    if (out.has(row.id)) continue;

    out.set(row.id, { id: row.id, title: row.title, excerpt: row.text.slice(0, chars) });
  }

  return out;
}

function judgePrompt(query: string, candidates: Candidate[]): string {
  const list = candidates
    .map((c, i) => `${String(i + 1)}. ${c.title}\n${c.excerpt}`)
    .join("\n\n---\n\n");

  return `QUESTION: ${query}\n\nCANDIDATES:\n\n${list}`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }

  const store = arg(argv, "--db");

  if (!store) {
    console.error("gold-adjudicate: --db PATH is required (see --help)");
    process.exitCode = 1;
    return;
  }

  const out = arg(argv, "--out") ?? `${process.env.HOME ?? "."}/.cerebrium/gold.jsonl`;
  const from = arg(argv, "--from") ?? "log";
  const limit = num(argv, "--limit", Infinity);
  const pool = num(argv, "--pool", 10);
  const excerptChars = num(argv, "--excerpt", 400);
  const model = arg(argv, "--model") ?? DEFAULT_MODEL;
  const url = arg(argv, "--url") ?? DEFAULT_URL;
  const timeoutMs = num(argv, "--timeout", 180_000);

  const container = buildContainer({
    role: "cli",
    source: new LayeredConfigSource(
      new StaticConfigSource({ MEMORY_DB_PATH: store }),
      new EnvConfigSource(),
    ),
    into: root.createChildContainer(),
  });

  // `search` touches the session table through HintsService; against a real store this must
  // not write a byte, so the hint source is stubbed and the tool is invoked below the audit
  // decorator that would otherwise log an event.
  container.register(HintsService, {
    useValue: { getUnknownSessionHints: () => Promise.resolve([]) } as unknown as HintsService,
  });

  const db = container.resolve<Database.Database>(DB_TOKEN);
  const tool = container.resolve(SearchTool);
  const existing = readGoldFile(out);
  const adjudicated = new Set(
    existing.entries
      .filter((e) => e.origin === "adjudicated")
      .map((e) => e.query.trim().toLowerCase()),
  );

  let queries: string[];

  if (from === "log") queries = queriesFromLog(db);
  else if (from === "gold") queries = [...new Set(existing.entries.map((e) => e.query))];
  else
    queries = readFileSync(from, "utf8")
      .split("\n")
      .filter((q) => q.trim().length > 3);

  const pending = queries
    .filter((q) => !adjudicated.has(q.trim().toLowerCase()))
    .slice(0, Number.isFinite(limit) ? limit : undefined);

  console.log(`store: ${store} (read-only)`);
  console.log(
    `queries from ${from}: ${String(queries.length)}, ${String(adjudicated.size)} already adjudicated, ${String(pending.length)} to do`,
  );

  if (!pending.length) return;

  console.log(`model: ${model} at ${url}\nout: ${out}\n`);

  const started = Date.now();
  let labelled = 0;
  let labels = 0;
  let empty = 0;
  let failed = 0;

  for (const [index, query] of pending.entries()) {
    const ids = new Set<string>();

    for (const mode of ["hybrid", "text", "vector"] as const) {
      const res = await tool.invoke({ session_id: "gold-adjudicate", query, limit: pool, mode });

      for (const hit of res.results) ids.add(hit.id);
    }

    const candidates = [...excerpts(db, [...ids], excerptChars).values()];

    if (!candidates.length) {
      empty++;
      continue;
    }

    let raw: string;

    try {
      raw = await chat(SYSTEM, judgePrompt(query, candidates), {
        url,
        model,
        timeoutMs,
        temperature: 0.1,
        numPredict: 200,
      });
    } catch (err) {
      failed++;
      console.log(`  ! ${query.slice(0, 60)}: ${(err as Error).message}`);
      continue;
    }

    const parsed = parseJsonObject(raw);
    const answers = Array.isArray(parsed?.answers) ? parsed.answers : [];
    const gold = answers
      .map((n) => (typeof n === "number" ? candidates[n - 1] : undefined))
      .filter((c): c is Candidate => !!c)
      .map((c) => c.id);

    if (!gold.length) {
      empty++;
      continue;
    }

    appendGold(out, [
      {
        query,
        gold: [...new Set(gold)],
        origin: "adjudicated",
        model,
        created: new Date().toISOString(),
      },
    ]);

    labelled++;
    labels += gold.length;

    const n = index + 1;

    if (n % 10 === 0 || n === pending.length) {
      const rate = (Date.now() - started) / 1000 / n;

      console.log(
        `  ${String(n)}/${String(pending.length)} queries — ${String(labelled)} labelled ` +
          `(${(labels / Math.max(labelled, 1)).toFixed(1)} labels each), ${String(empty)} with no answer, ` +
          `${String(failed)} failures, ${rate.toFixed(1)} s/query, ~${(((pending.length - n) * rate) / 60).toFixed(0)} min left`,
      );
    }
  }

  console.log(
    `\ndone: ${String(labelled)} queries labelled with ${String(labels)} query→node pairs ` +
      `(${String(empty)} judged to have no answer, ${String(failed)} failures)`,
  );
}

main().catch((e: unknown) => {
  console.error("gold-adjudicate failed:", e);
  process.exit(1);
});
