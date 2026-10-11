import "reflect-metadata";
import { readFileSync } from "node:fs";
import { unpairedBootstrap } from "@scripts/metrics";
import { LintRule, lintWrite, type LintFinding } from "@scripts/write-lint";
import type Database from "better-sqlite3";
import { container, type DependencyContainer } from "tsyringe";
import { PG_TOKEN, type PgDatabase } from "@/db/postgres/database";
import { DB_TOKEN } from "@/db/sqlite/base";
import { buildContainer } from "@/container";
import { EnvConfigSource, LayeredConfigSource, StaticConfigSource } from "@/infrastructure/config";

// Lints every live semantic node of a store and, given a per-query dump from
// `eval:retrieval --dump`, compares how well queries are answered when their answer fails a
// rule against when it passes. Read-only.

const HELP = `
lint-report — write-lint findings over a store, joined with retrieval scores.

  npm run report:lint -- (--db PATH | --pg URL) [--dump P] [--arm NAME] [--horizon H]

  --db PATH    SQLite store, opened READ-ONLY.
  --pg URL     Postgres store, read-only session.
  --dump P     JSONL from \`eval:retrieval --dump\`. Without it only the findings are listed.
  --arm NAME   Arm whose scores to read (default: the first one in each line).
  --horizon H  Horizon label to read from the dump (default "now").
  --examples N Titles to print per rule (default 5).
  --help       This text.

A query fails a rule when any of its gold nodes does. Deltas are mean(fail) − mean(pass)
nDCG@10 with a 95% band from resampling each group on its own.
`;

interface NodeRow {
  id: string;
  title: string;
  content: string;
}

interface DumpLine {
  horizon: string;
  gold: string[];
  ndcg: Record<string, number>;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);

  return i >= 0 ? argv[i + 1] : undefined;
}

type Rows = <T>(sql: string) => Promise<T[]>;

function rowsOf(scope: DependencyContainer): Rows {
  if (scope.isRegistered(PG_TOKEN, true)) {
    const pg = scope.resolve<PgDatabase>(PG_TOKEN);

    return async <T,>(sql: string) => (await pg.query(sql)).rows as T[];
  }

  const db = scope.resolve<Database.Database>(DB_TOKEN);

  return <T,>(sql: string) => Promise.resolve(db.prepare(sql).all() as T[]);
}

const signed = (x: number): string =>
  Number.isNaN(x) ? "-" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}`;
const pct = (xs: number[]): string =>
  xs.length ? ((xs.reduce((s, x) => s + x, 0) / xs.length) * 100).toFixed(1) : "-";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }

  const store = arg(argv, "--db");
  const pgUrl = arg(argv, "--pg");

  if (!store && !pgUrl) {
    console.error("lint-report: --db PATH or --pg URL is required (see --help)");
    process.exitCode = 1;
    return;
  }

  const scope = buildContainer({
    role: "cli",
    source: new LayeredConfigSource(
      new StaticConfigSource(
        pgUrl
          ? { MEMORY_STORE_BACKEND: "postgres", MEMORY_PG_URL: pgUrl }
          : { MEMORY_DB_PATH: store! },
      ),
      new EnvConfigSource(),
    ),
    into: container.createChildContainer(),
  });
  const nodes = await rowsOf(scope)<NodeRow>(
    `SELECT n.id, n.title, r.content
       FROM nodes n
       JOIN revisions r ON r.node_id = n.id
       JOIN (SELECT node_id, MAX(rev) AS rev FROM revisions GROUP BY node_id) m
         ON m.node_id = r.node_id AND m.rev = r.rev
      WHERE n.invalidated_at IS NULL AND n.memory_kind = 'semantic'`,
  );
  const findings = new Map<string, LintFinding[]>(nodes.map((node) => [node.id, lintWrite(node)]));
  const examples = Number(arg(argv, "--examples") ?? 5);
  const rules = Object.values(LintRule);

  console.log(`live semantic nodes: ${String(nodes.length)}`);
  console.log(
    `failing any rule: ${String([...findings.values()].filter((f) => f.length).length)}\n`,
  );

  for (const rule of rules) {
    const failing = nodes.filter((node) => findings.get(node.id)!.some((f) => f.rule === rule));

    console.log(`${rule}: ${String(failing.length)}`);

    for (const node of failing.slice(0, examples)) console.log(`    ${node.title.slice(0, 110)}`);
  }

  const dumpPath = arg(argv, "--dump");

  if (!dumpPath) return;

  const horizon = arg(argv, "--horizon") ?? "now";
  const armName = arg(argv, "--arm");
  const lines = readFileSync(dumpPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as DumpLine)
    .filter((line) => line.horizon === horizon && line.gold.every((id) => findings.has(id)));
  const scoreOf = (line: DumpLine): number =>
    line.ndcg[armName ?? Object.keys(line.ndcg)[0]!] ?? NaN;
  const fails = (line: DumpLine, rule?: LintRule): boolean =>
    line.gold.some((id) =>
      findings.get(id)!.some((finding) => rule === undefined || finding.rule === rule),
    );

  console.log(
    `\nqueries at '${horizon}' whose answers are all live semantic nodes: ${String(lines.length)}`,
  );
  console.log(
    "rule                    | n fail | n pass | nDCG fail | nDCG pass | fail − pass [95%]",
  );

  for (const rule of [undefined, ...rules]) {
    const fail = lines.filter((line) => fails(line, rule)).map(scoreOf);
    const pass = lines.filter((line) => !fails(line, rule)).map(scoreOf);
    const { delta, low, high } = unpairedBootstrap(pass, fail);

    console.log(
      `${(rule ?? "any").padEnd(23)} | ${String(fail.length).padStart(6)} | ${String(pass.length).padStart(6)} | ${pct(fail).padStart(9)} | ${pct(pass).padStart(9)} | ${signed(delta)} [${signed(low)}, ${signed(high)}]`,
    );
  }
}

main().catch((e: unknown) => {
  console.error("lint-report failed:", e);
  process.exit(1);
});
