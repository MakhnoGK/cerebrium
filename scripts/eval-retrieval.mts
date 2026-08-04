import "reflect-metadata";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  countByOrigin,
  filterByOrigin,
  parseOrigins,
  pruneStale,
  readGoldFile,
  toEvalQueries,
  type EvalQuery,
  type GoldEntry,
} from "@scripts/gold";
import type Database from "better-sqlite3";
import { container, type DependencyContainer } from "tsyringe";
import {
  EMBEDDING_PROVIDER_TOKEN,
  type EmbeddingProvider,
} from "@/domain/ports/embedding-provider";
import { HintsService } from "@/application/services";
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
// Below this many labelled queries the run refuses to report: means over a handful of
// queries move several points on one lucky ranking, and a number that noisy invites more
// confident conclusions than it can carry.
const MIN_GOLD_QUERIES = 20;
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
  --db PATH  Measure against a real store instead of the seeded corpus. Opened READ-ONLY
             and the session-hint write is stubbed out, so the run cannot touch it. Gold
             labels are mined from the retrieval-outcome log: within a session, a node a
             \`get\` fetched after a \`search\` returned it counts as relevant to that query.
             Prints the volume it found and refuses to score below ${MIN_GOLD_QUERIES} labelled queries.
  --gold P   JSONL gold file (see scripts/gold.ts) merged with the mined labels: the same
             question from two sources becomes one query with the union of its labels.
             Labels pointing at nodes no longer live are dropped and counted. Needs --db.
  --origin O Comma-separated subset of generated,adjudicated,mined — score only labels of
             those origins, e.g. to check whether synthetic questions and real ones agree.
  --min N    Lower that floor. Numbers below it are noise; use it to smoke-test the path
             or to peek at early data, not to draw conclusions.
  --help     This text.

Examples
  npm run eval:retrieval -- --arm off:MEMORY_RERANK=off --arm on:MEMORY_RERANK=local
  npm run eval:retrieval -- --arm relevance:MEMORY_MMR_LAMBDA=1.0 --arm diverse:MEMORY_MMR_LAMBDA=0.7
  npm run eval:retrieval -- --arm flat:MEMORY_USE_WEIGHT=0 --arm usage:MEMORY_USE_WEIGHT=0.25
  npm run eval:retrieval -- --db ~/.cerebrium/memory.db --gold ~/.cerebrium/gold.jsonl

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

// NaN for an empty sample, so a metric nothing was observed for prints as "-" instead of
// as a confident zero.
const mean = (xs: number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
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

// Gold labels mined from the retrieval-outcome log (A1): within one session, a node that
// `get` fetched after a `search` returned it — and before the next search — is treated as
// relevant to that query. This is implicit relevance, i.e. what the agent judged worth
// spending tokens on; it is not adjudicated ground truth and carries that bias. A narrowed
// fetch also names the sections read, which is a label at chunk granularity; an `outline`
// fetch is a decision aid rather than a read and is not counted as evidence at all.
function goldFromEvents(db: Database.Database): {
  entries: GoldEntry[];
  searches: number;
  sectionLabels: number;
} {
  const rows = db
    .prepare(
      `SELECT session_id, action, detail FROM events
       WHERE action IN ('search','get') AND detail LIKE '%"ids"%'
       ORDER BY session_id, ts, id`,
    )
    .all() as { session_id: string; action: string; detail: string }[];

  const entries: GoldEntry[] = [];
  let open: {
    query: string;
    returned: Set<string>;
    gold: Set<string>;
    sections: Map<string, Set<string>>;
  } | null = null;
  let session = "";
  let searches = 0;
  let sectionLabels = 0;

  const close = () => {
    if (open?.gold.size) {
      entries.push({
        query: open.query,
        gold: [...open.gold],
        origin: "mined",
        sections: Object.fromEntries([...open.sections].map(([id, names]) => [id, [...names]])),
      });
    }
    open = null;
  };

  for (const row of rows) {
    if (row.session_id !== session) {
      close();
      session = row.session_id;
    }

    let detail: { ids?: unknown; query?: unknown; sections?: unknown; outline?: unknown };

    try {
      detail = JSON.parse(row.detail) as typeof detail;
    } catch {
      continue;
    }

    const ids = Array.isArray(detail.ids) ? detail.ids.filter((x) => typeof x === "string") : [];

    if (row.action === "search") {
      close();

      if (typeof detail.query === "string" && ids.length) {
        searches++;
        open = {
          query: detail.query,
          returned: new Set(ids),
          gold: new Set(),
          sections: new Map(),
        };
      }

      continue;
    }

    // An outline decides whether to read; it is not a read, so it is no evidence of relevance.
    if (detail.outline === true) continue;

    const sections = Array.isArray(detail.sections)
      ? detail.sections.filter((x) => typeof x === "string")
      : [];

    // A fetch of something the open search never returned says nothing about that query.
    for (const id of ids) {
      if (!open?.returned.has(id)) continue;

      open.gold.add(id);

      if (!sections.length) continue;

      const seen = open.sections.get(id) ?? new Set<string>();

      for (const section of sections) {
        if (!seen.has(section)) sectionLabels++;
        seen.add(section);
      }

      open.sections.set(id, seen);
    }
  }

  close();

  return { entries, searches, sectionLabels };
}

// A label is only worth scoring while the node it points at is still live: an invalidated
// or merged-away node cannot be returned, so keeping it would score a correct ranking as
// a miss.
function liveNodes(db: Database.Database): Set<string> {
  const rows = db.prepare("SELECT id FROM nodes WHERE invalidated_at IS NULL").all() as {
    id: string;
  }[];

  return new Set(rows.map((r) => r.id));
}

async function runArm(
  arm: Arm,
  queries: EvalQuery[],
  shared: { db: Database.Database; provider: EmbeddingProvider; readonly: boolean },
  facetOf: Map<string, string>,
): Promise<Scores> {
  // A fresh container per arm so every config section is rebuilt from the arm's overlay,
  // sharing the seeded DB and embeddings so only the knob differs.
  const scope = container.createChildContainer();

  buildContainer({
    role: shared.readonly ? "cli" : "server",
    source: new LayeredConfigSource(new StaticConfigSource(arm.env), new EnvConfigSource()),
    into: scope,
  });
  scope.register(DB_TOKEN, { useValue: shared.db });
  scope.register(EMBEDDING_PROVIDER_TOKEN, { useValue: shared.provider });

  // `search` normally touches the session table through HintsService. Against a real store
  // this eval must not write a single byte, so the hint source is stubbed out and the tool
  // is invoked directly, below the audit decorator that would otherwise log an event.
  if (shared.readonly) {
    scope.register(HintsService, {
      useValue: { getUnknownSessionHints: () => Promise.resolve([]) } as unknown as HintsService,
    });
  }

  const tool = scope.resolve(SearchTool);
  const sid = shared.readonly
    ? "eval-readonly"
    : (await scope.resolve(SessionStartTool).invoke({})).session_id;
  const scores: Scores = { rr: [], ndcg: [], p1: [], recall: [], facets: [] };

  for (const q of queries) {
    const res = await tool.invoke({ session_id: sid, query: q.query, limit: K });
    const ranked = res.results.map((r) => r.id);
    const facet = facetCoverage(ranked, q.gold, facetOf, FACET_K);

    scores.rr.push(reciprocalRank(ranked, q.gold));
    scores.ndcg.push(ndcgAtK(ranked, q.gold, K));
    scores.p1.push(precisionAt1(ranked, q.gold));
    scores.recall.push(recallAtK(ranked, q.gold, K));

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
  const arms = parseArms(argv);
  const store = argv[argv.indexOf("--db") + 1];
  const readonly = argv.includes("--db") && !!store;
  const floor = argv.includes("--min")
    ? Number(argv[argv.indexOf("--min") + 1] ?? MIN_GOLD_QUERIES)
    : MIN_GOLD_QUERIES;

  // Against a real store the DB is opened through the `cli` role, which is read-only.
  const root = buildContainer({
    role: readonly ? "cli" : "server",
    source: new LayeredConfigSource(
      new StaticConfigSource({ MEMORY_DB_PATH: readonly ? store : ":memory:" }),
      new EnvConfigSource(),
    ),
    into: container.createChildContainer(),
  });

  const db = root.resolve<Database.Database>(DB_TOKEN);
  const provider = root.resolve<EmbeddingProvider>(EMBEDDING_PROVIDER_TOKEN);
  let queries: EvalQuery[];
  let facetOf = new Map<string, string>();

  console.log(`embeddings: ${provider.name}`);

  if (readonly) {
    const { entries: mined, searches, sectionLabels } = goldFromEvents(db);
    const goldPath = argv.includes("--gold") ? argv[argv.indexOf("--gold") + 1] : undefined;
    const fromFile = goldPath ? readGoldFile(goldPath) : { entries: [], malformed: 0 };
    const origins = parseOrigins(
      argv.includes("--origin") ? argv[argv.indexOf("--origin") + 1] : undefined,
    );
    const live = liveNodes(db);
    const { kept, droppedLabels, droppedQueries } = pruneStale(
      filterByOrigin([...fromFile.entries, ...mined], origins),
      (id) => live.has(id),
    );

    queries = toEvalQueries(kept);

    const pairs = queries.reduce((n, q) => n + q.gold.size, 0);
    const counts = countByOrigin(kept);

    console.log(`store: ${store} (read-only)`);

    if (goldPath) {
      console.log(
        `gold file: ${goldPath} — ${fromFile.entries.length} entries${fromFile.malformed ? `, ${fromFile.malformed} malformed lines skipped` : ""}`,
      );
    }

    console.log(
      `retrieval-outcome log: ${mined.length} queries with a fetch, out of ${searches} logged searches`,
    );
    console.log(
      `scoring ${queries.length} distinct queries, ${pairs} query→node pairs ` +
        `(generated ${counts.generated}, adjudicated ${counts.adjudicated}, mined ${counts.mined})`,
    );

    if (droppedLabels) {
      console.log(
        `dropped ${droppedLabels} labels pointing at nodes no longer live (${droppedQueries} queries lost every label) — regenerate if this share grows`,
      );
    }

    console.log(
      `of those, ${sectionLabels} query→node→section labels from the log (nothing scores them yet; the metrics below are node-level)\n`,
    );

    if (queries.length < floor) {
      console.log(
        `Not enough labelled data to measure anything: ${queries.length} usable queries, ${floor} is the floor.\n` +
          `Mined labels grow only with use; manufacture the rest with \`gold-generate\` and \`gold-adjudicate\`,\n` +
          `then pass the file with --gold. The seeded corpus (no --db) works today.`,
      );
      return;
    }
  } else {
    const data = JSON.parse(
      readFileSync(join(here, "eval-retrieval.dataset.json"), "utf8"),
    ) as Dataset;

    console.log(
      `corpus: ${data.docs.length} docs, ${data.edges?.length ?? 0} edges   queries: ${data.queries.length}   arms: ${arms.map((a) => a.name).join(", ")}\n`,
    );

    const byTitle = await seed(root, data);
    const titleOf = new Map(data.docs.map((d) => [d.id, d.title]));

    queries = data.queries.map((q) => ({
      query: q.query,
      gold: new Set(
        q.relevant
          .map((datasetId) => byTitle.get(titleOf.get(datasetId) ?? ""))
          .filter((x): x is string => !!x),
      ),
      origins: new Set<never>(),
    }));
    facetOf = new Map(
      data.docs
        .filter((d) => d.facet)
        .map((d) => [byTitle.get(d.title) ?? d.id, d.facet!] as const),
    );
  }

  console.log(`arm          |   MRR | nDCG@${K} |   P@1 | Rec@${K} | Facet@${FACET_K}`);
  console.log("-------------+-------+---------+-------+--------+---------");

  const table: { arm: Arm; scores: Scores }[] = [];

  for (const arm of arms) {
    const scores = await runArm(arm, queries, { db, provider, readonly }, facetOf);

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

        if (Number.isNaN(delta)) return "-";

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
