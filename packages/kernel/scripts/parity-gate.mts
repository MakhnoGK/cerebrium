import "reflect-metadata";
import {
  filterByOrigin,
  parseOrigins,
  pruneStale,
  readGoldFile,
  toEvalQueries,
  type GoldEntry,
} from "@scripts/gold";
import { sample } from "@scripts/metrics";
import { DEFAULT_RULES, measureParity, parityFailures, type BranchScores } from "@scripts/parity";
import type Database from "better-sqlite3";
import { container } from "tsyringe";
import { MemoryKind } from "@cerebrium/contracts/vocab";
import {
  EMBEDDING_PROVIDER_TOKEN,
  type EmbeddingProvider,
} from "@/domain/ports/embedding-provider";
import { STORE_TOKEN, type Store } from "@/domain/ports/storage";
import { DB_TOKEN } from "@/db/sqlite/base";
import { buildContainer } from "@/container";
import {
  ConsolidationThresholdsConfig,
  EnvConfigSource,
  LayeredConfigSource,
  RetrievalConfig,
  StaticConfigSource,
} from "@/infrastructure/config";

const HELP = `
parity-gate — may a Postgres import replace the SQLite store it came from?

  npm run parity:pg -- --sqlite PATH --pg URL --gold PATH [--gold PATH] [options]

  --sqlite PATH  The SQLite store (a .backup copy), opened READ-ONLY.
  --pg URL       Its Postgres import (npm run import:sqlite), opened read-only.
  --gold PATH    Gold JSONL; repeatable. Labels on nodes no longer live are dropped.
  --origin O     Only labels of these origins (generated,adjudicated,mined).
  --sample N     A stable subset of N queries.
  --help         This text.

Both stores answer the same queries with the same query vectors, restricted to authored
memory (the Postgres store holds no code mirror). It passes when:
  - the vector branch's top-40 overlap is at least ${String(DEFAULT_RULES.minJaccard)} (Jaccard) for every query and
    shared neighbours' distances differ by less than ${DEFAULT_RULES.maxDistanceDelta.toExponential(0)};
  - text and hybrid nDCG@10 and Recall@10 trail SQLite by no more than ${String(DEFAULT_RULES.maxWorse)} point;
  - no labelled merge pair falls on the other side of a similarity gate.
Latency is reported, not gated. Exits 1 when any rule fails.
`;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);

  return i >= 0 ? argv[i + 1] : undefined;
}

function args(argv: string[], name: string): string[] {
  return argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]!] : []));
}

function row(name: string, b: BranchScores): string {
  const d = (x: number, y: number) => `${y - x >= 0 ? "+" : ""}${(y - x).toFixed(1)}`;

  return (
    `${name.padEnd(7)} nDCG@10 ${b.sqlite.ndcg.toFixed(1)} -> ${b.pg.ndcg.toFixed(1)} (${d(b.sqlite.ndcg, b.pg.ndcg)})` +
    `   Rec@10 ${b.sqlite.recall.toFixed(1)} -> ${b.pg.recall.toFixed(1)} (${d(b.sqlite.recall, b.pg.recall)})` +
    `   p50 ${b.sqlite.p50.toFixed(0)} / ${b.pg.p50.toFixed(0)} ms   p95 ${b.sqlite.p95.toFixed(0)} / ${b.pg.p95.toFixed(0)} ms` +
    `   lost ${String(b.lost.length)}`
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }

  const sqlitePath = arg(argv, "--sqlite");
  const pgUrl = arg(argv, "--pg");
  const goldPaths = args(argv, "--gold");

  if (!sqlitePath || !pgUrl || !goldPaths.length) {
    console.error("parity-gate: --sqlite, --pg and at least one --gold are required (see --help)");
    process.exitCode = 2;
    return;
  }

  const open = (env: Record<string, string>) =>
    buildContainer({
      role: "cli",
      source: new LayeredConfigSource(new StaticConfigSource(env), new EnvConfigSource()),
      into: container.createChildContainer(),
    });
  const sqlite = open({ MEMORY_STORE_BACKEND: "sqlite", MEMORY_DB_PATH: sqlitePath });
  const pg = open({ MEMORY_STORE_BACKEND: "postgres", MEMORY_PG_URL: pgUrl });
  const provider = sqlite.resolve<EmbeddingProvider>(EMBEDDING_PROVIDER_TOKEN);

  pg.register(EMBEDDING_PROVIDER_TOKEN, { useValue: provider });

  const db = sqlite.resolve<Database.Database>(DB_TOKEN);
  const live = new Set(
    (db.prepare("SELECT id FROM nodes WHERE invalidated_at IS NULL").all() as { id: string }[]).map(
      (r) => r.id,
    ),
  );
  const entries: GoldEntry[] = goldPaths.flatMap((p) => readGoldFile(p).entries);
  const { kept, droppedLabels } = pruneStale(
    filterByOrigin(entries, parseOrigins(arg(argv, "--origin"))),
    (id) => live.has(id),
  );
  const size = Number(arg(argv, "--sample") ?? Infinity);
  const queries = sample(toEvalQueries(kept), Number.isFinite(size) ? size : Infinity);
  const pairs = (
    db
      .prepare(
        `SELECT member_ids FROM consolidation_candidates
         WHERE kind = 'merge' AND status IN ('applied', 'dismissed')`,
      )
      .all() as { member_ids: string }[]
  )
    .map((r) => JSON.parse(r.member_ids) as string[])
    .filter((m): m is [string, string] => m.length === 2);
  const retrieval = sqlite.resolve(RetrievalConfig);
  const thresholds = sqlite.resolve(ConsolidationThresholdsConfig);
  const gates = {
    dedup: retrieval.dedupThreshold,
    fold: retrieval.foldSim,
    link: thresholds.sim,
    merge: thresholds.mergeSim,
  };

  console.log(`sqlite: ${sqlitePath} (read-only)`);
  console.log(`pg:     ${pg.resolve<Store>(STORE_TOKEN).identity} (read-only)`);
  console.log(
    `queries: ${String(queries.length)} (${String(droppedLabels)} labels on retired nodes dropped)   merge pairs: ${String(pairs.length)}   embeddings: ${provider.name}\n`,
  );

  const report = await measureParity({
    sqlite,
    pg,
    provider,
    queries,
    kinds: [MemoryKind.SEMANTIC, MemoryKind.EPISODIC],
    pairs,
    gates,
  });

  console.log(
    `vector  top-40 Jaccard mean ${report.vector.meanJaccard.toFixed(4)} min ${report.vector.minJaccard.toFixed(4)}` +
      `   max Δdistance ${report.vector.maxDistanceDelta.toExponential(2)}` +
      `   p50 ${report.vector.p50.sqlite.toFixed(0)} / ${report.vector.p50.pg.toFixed(0)} ms`,
  );
  console.log(row("text", report.text));
  console.log(row("hybrid", report.hybrid));
  console.log(
    `gates   ${String(report.gates.compared)}/${String(report.gates.pairs)} merge pairs compared` +
      `   max Δcosine ${report.gates.maxDelta.toExponential(2)}   flips ${String(report.gates.flips.length)}`,
  );

  for (const [name, b] of [
    ["text", report.text],
    ["hybrid", report.hybrid],
  ] as const) {
    for (const l of b.lost.slice(0, 5)) {
      console.log(
        `  ${name} lost: ${l.sqlite.toFixed(2)} -> ${l.pg.toFixed(2)}  ${l.query.slice(0, 90)}`,
      );
    }
  }

  const failures = parityFailures(report);

  console.log(failures.length ? `\nFAIL\n  ${failures.join("\n  ")}` : "\nPASS");

  if (failures.length) process.exitCode = 1;

  await pg.resolve<Store>(STORE_TOKEN).close();
  await sqlite.resolve<Store>(STORE_TOKEN).close();
}

main().catch((err: unknown) => {
  console.error(`parity-gate failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
