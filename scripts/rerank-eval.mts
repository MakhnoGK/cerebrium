import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "@/db/database";
import { Repo } from "@/db/repo";
import { nowIso } from "@/core/ids";
import { createProvider } from "@/embeddings/index";
import { createReranker } from "@/rerank/index";
import { EmbeddingWorker } from "@/embeddings/worker";
import type { Ctx } from "@/tools/context";
import * as session_start from "@/tools/session_start";
import * as write from "@/tools/write";
import * as search from "@/tools/search";

// Offline relevance eval: measure whether the `local` cross-encoder reranker
// improves search precision over RRF-only fusion on a labeled query set. Both runs
// share the same seeded corpus and embeddings and differ only in the rerank stage,
// so the deltas isolate the reranker's contribution. Not part of `npm test` (it
// downloads models); run with `npm run eval:rerank`. Env: MEMORY_EMBED_PROVIDER
// (default local), MEMORY_RERANK (default local).

const K = 10;

interface Doc {
  id: string;
  title: string;
  content: string;
}
interface Query {
  query: string;
  relevant: string[];
}
interface Dataset {
  docs: Doc[];
  queries: Query[];
}

function reciprocalRank(ranked: string[], gold: Set<string>): number {
  for (let i = 0; i < ranked.length; i++) if (gold.has(ranked[i]!)) return 1 / (i + 1);
  return 0;
}
function ndcgAtK(ranked: string[], gold: Set<string>, k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++)
    if (gold.has(ranked[i]!)) dcg += 1 / Math.log2(i + 2);
  let idcg = 0;
  for (let i = 0; i < Math.min(k, gold.size); i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}
function precisionAt1(ranked: string[], gold: Set<string>): number {
  return ranked.length > 0 && gold.has(ranked[0]!) ? 1 : 0;
}
function recallAtK(ranked: string[], gold: Set<string>, k: number): number {
  const top = new Set(ranked.slice(0, k));
  let hit = 0;
  for (const g of gold) if (top.has(g)) hit++;
  return gold.size === 0 ? 0 : hit / gold.size;
}
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x: number): string => (x * 100).toFixed(1).padStart(5);

// Docs are stored under ULIDs, so gold labels (dataset ids) are resolved by title.
function titlesToIds(db: Database.Database): Map<string, string> {
  const rows = db.prepare("SELECT id, title FROM nodes WHERE memory_kind = 'semantic'").all() as {
    id: string;
    title: string;
  }[];
  return new Map(rows.map((r) => [r.title, r.id]));
}

async function rankedIds(ctx: Ctx, sid: string, query: string): Promise<string[]> {
  const res = (await search.handler(ctx, { session_id: sid, query, limit: K })) as {
    results: { id: string }[];
  };
  return res.results.map((r) => r.id);
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const data = JSON.parse(readFileSync(join(here, "rerank-eval.dataset.json"), "utf8")) as Dataset;

  const provider = createProvider(process.env.MEMORY_EMBED_PROVIDER || "local");
  const db = openDatabase(":memory:");
  const repo = new Repo(db);
  const shared: Omit<Ctx, "reranker"> = { repo, now: nowIso, workingSetBudget: 1500, provider };
  const ctxOff: Ctx = { ...shared, reranker: createReranker("off") };
  const ctxOn: Ctx = { ...shared, reranker: createReranker(process.env.MEMORY_RERANK || "local") };

  console.log(
    `embeddings: ${provider.name}   reranker: ${ctxOn.reranker.name} (enabled=${ctxOn.reranker.enabled})`,
  );
  console.log(`corpus: ${data.docs.length} docs   queries: ${data.queries.length}\n`);

  const sid = (await session_start.handler(ctxOff, {})).session_id;
  for (const d of data.docs) {
    await write.handler(ctxOff, {
      session_id: sid,
      memory_kind: "semantic",
      type: "fact",
      title: d.title,
      content: `${d.title}. ${d.content}`,
    });
  }
  const worker = new EmbeddingWorker(repo, provider, nowIso);
  let guard = 0;
  while ((await worker.tick()).embedded > 0 && guard++ < 1000) {
    /* drain the embedding queue */
  }

  const byTitle = titlesToIds(db);
  const idToTitle = new Map(data.docs.map((d) => [d.id, d.title]));
  const goldOf = (q: Query): Set<string> =>
    new Set(
      q.relevant
        .map((datasetId) => byTitle.get(idToTitle.get(datasetId) ?? ""))
        .filter((x): x is string => !!x),
    );

  const a = {
    offRR: [] as number[],
    onRR: [] as number[],
    offND: [] as number[],
    onND: [] as number[],
    offP1: [] as number[],
    onP1: [] as number[],
    offRec: [] as number[],
    onRec: [] as number[],
  };

  console.log("per-query nDCG@10 (baseline -> reranked):");
  for (const q of data.queries) {
    const gold = goldOf(q);
    const offIds = await rankedIds(ctxOff, sid, q.query);
    const onIds = await rankedIds(ctxOn, sid, q.query);
    const offND = ndcgAtK(offIds, gold, K),
      onND = ndcgAtK(onIds, gold, K);
    a.offRR.push(reciprocalRank(offIds, gold));
    a.onRR.push(reciprocalRank(onIds, gold));
    a.offND.push(offND);
    a.onND.push(onND);
    a.offP1.push(precisionAt1(offIds, gold));
    a.onP1.push(precisionAt1(onIds, gold));
    a.offRec.push(recallAtK(offIds, gold, K));
    a.onRec.push(recallAtK(onIds, gold, K));
    const arrow = onND > offND + 1e-9 ? "↑" : onND < offND - 1e-9 ? "↓" : "=";
    console.log(`  ${arrow} ${pct(offND)} -> ${pct(onND)}   "${q.query.slice(0, 52)}"`);
  }

  const row = (label: string, off: number[], on: number[]) => {
    const o = mean(off),
      n = mean(on),
      d = n - o;
    console.log(
      `  ${label.padEnd(12)} ${pct(o)}  ->  ${pct(n)}   (${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)} pts)`,
    );
  };
  console.log("\naggregate (mean, baseline -> reranked):");
  row("MRR", a.offRR, a.onRR);
  row("nDCG@10", a.offND, a.onND);
  row("P@1", a.offP1, a.onP1);
  row("Recall@10", a.offRec, a.onRec);

  const lift = mean(a.onND) - mean(a.offND);
  console.log(
    `\nverdict: reranker ${lift > 0.001 ? "IMPROVES" : lift < -0.001 ? "REGRESSES" : "is NEUTRAL on"} nDCG@10 by ${(lift * 100).toFixed(1)} pts.`,
  );
}

main().catch((e: unknown) => {
  console.error("eval failed:", e);
  process.exit(1);
});
