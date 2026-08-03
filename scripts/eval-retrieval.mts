import "reflect-metadata";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { container, type DependencyContainer } from "tsyringe";
import {
  EMBEDDING_PROVIDER_TOKEN,
  type EmbeddingProvider,
} from "@/domain/ports/embedding-provider";
import { EmbeddingWorker } from "@/application/workers";
import { DB_TOKEN } from "@/db/repositories/base";
import { EdgeType, MemoryKind } from "@/core/vocab";
import { LinkTool } from "@/presentation/mcp/tools/link";
import { SearchTool } from "@/presentation/mcp/tools/search";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { buildContainer } from "@/container";
import { EnvConfigSource, LayeredConfigSource, StaticConfigSource } from "@/infrastructure/config";

// Offline relevance eval for the retrieval pipeline. Runs the same labelled corpus through
// two or more "arms" — named configuration overlays — so the effect of one knob is read off
// identical documents, identical embeddings and identical queries. Not part of `npm test`
// (it may download models); run with `npm run eval:retrieval`.
//
// The corpus is 36 short docs in an in-memory DB. That is enough to answer "does this knob
// help on labelled data" and NOT enough to reproduce the anisotropy and candidate starvation
// of a 125k-node store — an arm that wins here has stopped being a guess, not become proven.

const K = 10;
// Facet coverage is read at a tighter cut than the relevance metrics on purpose: diversity
// only matters where the window is contested. At K=10 on this corpus every gold answer fits,
// so the metric would read 100% for any ranking and measure nothing.
const FACET_K = 3;

interface Doc {
  id: string;
  title: string;
  content: string;
  facet?: string;
}
interface Query {
  query: string;
  relevant: string[];
}
interface Edge {
  src: string;
  dst: string;
  type: string;
}
interface Dataset {
  docs: Doc[];
  queries: Query[];
  edges?: Edge[];
}

interface Arm {
  name: string;
  env: Record<string, string>;
}

interface Scores {
  rr: number[];
  ndcg: number[];
  p1: number[];
  recall: number[];
  facets: number[];
}

const HELP = `
eval-retrieval — labelled relevance eval across configuration arms.

  npm run eval:retrieval -- [--arm NAME[:KEY=VAL,KEY=VAL]] ...

  --arm      An arm to measure. Repeatable. "NAME" alone runs the ambient environment;
             "NAME:KEY=VAL" overlays those variables on top of it. With no --arm, a single
             'base' arm runs.
  --help     This text.

Examples
  npm run eval:retrieval -- --arm off:MEMORY_RERANK=off --arm on:MEMORY_RERANK=local
  npm run eval:retrieval -- --arm relevance:MEMORY_MMR_LAMBDA=1.0 --arm diverse:MEMORY_MMR_LAMBDA=0.7
  npm run eval:retrieval -- --arm flat:MEMORY_USE_WEIGHT=0 --arm usage:MEMORY_USE_WEIGHT=0.25

Metrics are means over the query set: MRR, nDCG@${K}, P@1, Recall@${K}, and Facet@${FACET_K} —
the share of distinct gold facets covered by the returned set, which is what a diversity
stage trades relevance for and what nDCG cannot see.
`;

function parseArms(argv: string[]): Arm[] {
  const arms: Arm[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--arm") continue;

    const spec = argv[++i] ?? "";
    const [name, assignments] = spec.split(/:(.+)/);
    const env: Record<string, string> = {};

    for (const pair of assignments?.split(",") ?? []) {
      const [key, value] = pair.split("=");

      if (key && value !== undefined) env[key.trim()] = value.trim();
    }

    if (name) arms.push({ name, env });
  }

  return arms.length ? arms : [{ name: "base", env: {} }];
}

function reciprocalRank(ranked: string[], gold: Set<string>): number {
  for (let i = 0; i < ranked.length; i++) {
    if (gold.has(ranked[i]!)) return 1 / (i + 1);
  }

  return 0;
}

function ndcgAtK(ranked: string[], gold: Set<string>, k: number): number {
  let dcg = 0;

  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (gold.has(ranked[i]!)) dcg += 1 / Math.log2(i + 2);
  }

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

// How many of the distinct facets among a query's gold answers appear in the top k. A run
// that returns three paraphrases of one facet scores 1/2 here and near-perfect nDCG.
function facetCoverage(
  ranked: string[],
  gold: Set<string>,
  facetOf: Map<string, string>,
  k: number,
): number {
  const wanted = new Set([...gold].map((id) => facetOf.get(id)).filter(Boolean));

  if (!wanted.size) return NaN;

  const covered = new Set(
    ranked
      .slice(0, k)
      .filter((id) => gold.has(id))
      .map((id) => facetOf.get(id))
      .filter(Boolean),
  );

  return covered.size / wanted.size;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x: number): string => (Number.isNaN(x) ? "    -" : (x * 100).toFixed(1).padStart(5));

// Docs are stored under ULIDs, so dataset ids are resolved by title.
function titlesToIds(db: Database.Database): Map<string, string> {
  const rows = db.prepare("SELECT id, title FROM nodes WHERE memory_kind = 'semantic'").all() as {
    id: string;
    title: string;
  }[];

  return new Map(rows.map((r) => [r.title, r.id]));
}

async function seed(root: DependencyContainer, data: Dataset): Promise<Map<string, string>> {
  const sid = (await root.resolve(SessionStartTool).invoke({})).session_id;
  const writeTool = root.resolve(WriteTool);

  for (const d of data.docs) {
    await writeTool.invoke({
      session_id: sid,
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title: d.title,
      content: `${d.title}. ${d.content}`,
    });
  }

  const byTitle = titlesToIds(root.resolve<Database.Database>(DB_TOKEN));
  const idOf = (datasetId: string): string | undefined =>
    byTitle.get(data.docs.find((d) => d.id === datasetId)?.title ?? "");

  // Edges are what make the graph stage measurable: a query whose answer hangs off a link
  // scores nothing unless expansion follows it.
  for (const e of data.edges ?? []) {
    const src = idOf(e.src);
    const dst = idOf(e.dst);

    if (src && dst) {
      await root.resolve(LinkTool).invoke({ session_id: sid, src, dst, type: e.type as EdgeType });
    }
  }

  const worker = root.resolve(EmbeddingWorker);
  let guard = 0;

  while ((await worker.tick()).embedded > 0 && guard++ < 1000) {
    /* drain the embedding queue */
  }

  return byTitle;
}

async function runArm(
  arm: Arm,
  data: Dataset,
  shared: { db: Database.Database; provider: EmbeddingProvider },
  goldOf: (q: Query) => Set<string>,
  facetOf: Map<string, string>,
): Promise<Scores> {
  // A fresh container per arm so every config section is rebuilt from the arm's overlay,
  // sharing the seeded DB and embeddings so only the knob differs.
  const scope = container.createChildContainer();

  buildContainer({
    role: "server",
    source: new LayeredConfigSource(new StaticConfigSource(arm.env), new EnvConfigSource()),
    into: scope,
  });
  scope.register(DB_TOKEN, { useValue: shared.db });
  scope.register(EMBEDDING_PROVIDER_TOKEN, { useValue: shared.provider });

  const tool = scope.resolve(SearchTool);
  const sid = (await scope.resolve(SessionStartTool).invoke({})).session_id;
  const scores: Scores = { rr: [], ndcg: [], p1: [], recall: [], facets: [] };

  for (const q of data.queries) {
    const gold = goldOf(q);
    const res = await tool.invoke({ session_id: sid, query: q.query, limit: K });
    const ranked = res.results.map((r) => r.id);
    const facet = facetCoverage(ranked, gold, facetOf, FACET_K);

    scores.rr.push(reciprocalRank(ranked, gold));
    scores.ndcg.push(ndcgAtK(ranked, gold, K));
    scores.p1.push(precisionAt1(ranked, gold));
    scores.recall.push(recallAtK(ranked, gold, K));

    if (!Number.isNaN(facet)) scores.facets.push(facet);
  }

  return scores;
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const data = JSON.parse(
    readFileSync(join(here, "eval-retrieval.dataset.json"), "utf8"),
  ) as Dataset;
  const arms = parseArms(argv);

  // The one wiring path every host uses, with the DB pinned to memory so a run never
  // touches the real store.
  const root = buildContainer({
    role: "server",
    source: new LayeredConfigSource(
      new StaticConfigSource({ MEMORY_DB_PATH: ":memory:" }),
      new EnvConfigSource(),
    ),
    into: container.createChildContainer(),
  });

  const db = root.resolve<Database.Database>(DB_TOKEN);
  const provider = root.resolve<EmbeddingProvider>(EMBEDDING_PROVIDER_TOKEN);

  console.log(`embeddings: ${provider.name}`);
  console.log(
    `corpus: ${data.docs.length} docs, ${data.edges?.length ?? 0} edges   queries: ${data.queries.length}   arms: ${arms.map((a) => a.name).join(", ")}\n`,
  );

  const byTitle = await seed(root, data);
  const titleOf = new Map(data.docs.map((d) => [d.id, d.title]));
  const goldOf = (q: Query): Set<string> =>
    new Set(
      q.relevant
        .map((datasetId) => byTitle.get(titleOf.get(datasetId) ?? ""))
        .filter((x): x is string => !!x),
    );
  const facetOf = new Map(
    data.docs.filter((d) => d.facet).map((d) => [byTitle.get(d.title) ?? d.id, d.facet!] as const),
  );

  console.log(`arm          |   MRR | nDCG@${K} |   P@1 | Rec@${K} | Facet@${FACET_K}`);
  console.log("-------------+-------+---------+-------+--------+---------");

  const table: { arm: Arm; scores: Scores }[] = [];

  for (const arm of arms) {
    const scores = await runArm(arm, data, { db, provider }, goldOf, facetOf);

    table.push({ arm, scores });
    console.log(
      `${arm.name.padEnd(12)} | ${pct(mean(scores.rr))} | ${pct(mean(scores.ndcg))}   | ${pct(mean(scores.p1))} | ${pct(mean(scores.recall))}  | ${pct(mean(scores.facets))}`,
    );
  }

  if (table.length > 1) {
    const first = table[0]!;

    console.log(`\ndeltas vs '${first.arm.name}' (percentage points):`);

    for (const row of table.slice(1)) {
      const d = (a: number[], b: number[]) => {
        const delta = (mean(b) - mean(a)) * 100;
        return `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}`;
      };

      console.log(
        `  ${row.arm.name.padEnd(12)} nDCG ${d(first.scores.ndcg, row.scores.ndcg).padStart(6)}   Rec ${d(first.scores.recall, row.scores.recall).padStart(6)}   Facet ${d(first.scores.facets, row.scores.facets).padStart(6)}`,
      );
    }
  }
}

main().catch((e: unknown) => {
  console.error("eval failed:", e);
  process.exit(1);
});
