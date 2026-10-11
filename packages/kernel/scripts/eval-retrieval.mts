import "reflect-metadata";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGE_BUCKETS,
  countByOrigin,
  filterByOrigin,
  liveAt,
  parseOrigins,
  pruneStale,
  queryAge,
  readGoldFile,
  toEvalQueries,
  type EvalQuery,
  type GoldEntry,
  type NodeSpan,
} from "@scripts/gold";
import {
  ndcgAtK,
  pairedBootstrap,
  precisionAt1,
  recallAtK,
  reciprocalRank,
  sample,
} from "@scripts/metrics";
import type Database from "better-sqlite3";
import { container, type DependencyContainer } from "tsyringe";
import { EdgeType, MemoryKind } from "@cerebrium/contracts/vocab";
import {
  EMBEDDING_PROVIDER_TOKEN,
  type EmbeddingProvider,
} from "@/domain/ports/embedding-provider";
import { HintsService } from "@/application/services";
import { EmbeddingWorker } from "@/application/workers";
import { PG_TOKEN, type PgDatabase } from "@/db/postgres/database";
import { DB_TOKEN } from "@/db/sqlite/base";
import { matchesSection, sectionName } from "@/core/chunk";
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
  secAcc: number[];
}

interface Horizon {
  label: string;
  asOf?: string;
}

interface Run {
  horizon: Horizon;
  queries: EvalQuery[];
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
  --pg URL   The same against a Postgres store. An arm may point at another one with
             MEMORY_PG_URL; labels are then kept only for nodes live in every arm's store.
  --gold P   JSONL gold file (see scripts/gold.ts) merged with the mined labels: the same
             question from two sources becomes one query with the union of its labels.
             Labels pointing at nodes no longer live are dropped and counted. Needs --db or --pg.
  --origin O Comma-separated subset of generated,adjudicated,mined — score only labels of
             those origins, e.g. to check whether synthetic questions and real ones agree.
  --sample N Score a stable subset of N queries, chosen by hashing the query text — the
             same subset for every arm and for every re-run, so a sweep over a few
             thousand labels stays interactive without making two runs incomparable.
  --mode M   Search mode for every query: hybrid (default), text or vector — to score one
             branch on its own.
  --kinds K  Comma-separated memory kinds every query is restricted to, e.g.
             semantic,episodic to compare stores that do not both hold the code mirror.
  --min N    Lower that floor. Numbers below it are noise; use it to smoke-test the path
             or to peek at early data, not to draw conclusions.
  --as-of T  Score the store as it stood at T (ISO-8601, or "now"). Repeatable: one table
             per horizon. Every query runs with \`as_of\`, and a label counts only if its
             node was live at T. Needs --db or --pg. The text index holds current wording,
             so T picks which nodes compete, not how they read then.
  --dump P   Write one JSONL line per scored query to P (horizon, query, gold ids, and
             nDCG@${K} and reciprocal rank per arm), for joining with per-node data.
  --help     This text.

Examples
  npm run eval:retrieval -- --arm relevance:MEMORY_MMR_LAMBDA=1.0 --arm diverse:MEMORY_MMR_LAMBDA=0.7
  npm run eval:retrieval -- --arm flat:MEMORY_USE_WEIGHT=0 --arm usage:MEMORY_USE_WEIGHT=0.25
  npm run eval:retrieval -- --db ~/.cerebrium/memory.db --gold ~/.cerebrium/gold.jsonl
  npm run eval:retrieval -- --db snap.db --kinds semantic,episodic --arm sqlite \
    --arm pg:MEMORY_STORE_BACKEND=postgres,MEMORY_PG_URL=postgres://u:p@localhost/snap
  npm run eval:retrieval -- --pg postgres://u:p@localhost/after \
    --arm before:MEMORY_PG_URL=postgres://u:p@localhost/before --arm after
  npm run eval:retrieval -- --pg postgres://u:p@localhost/snap --gold ~/.cerebrium/gold.jsonl \
    --as-of 2026-08-01 --as-of 2026-09-01 --as-of now

Metrics are means over the query set: MRR, nDCG@${K}, P@1, Recall@${K}, Facet@${FACET_K} (the
share of distinct gold facets covered by the returned set), and SecAcc@${K} (the share of
returned gold nodes whose returned chunk fell into a gold section). Deltas against the first
arm carry a 95% band for MRR and nDCG from resampling the queries. Against a real store each
table is followed by nDCG@${K} per age of the query's youngest answer at that horizon.
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

function parseHorizons(argv: string[]): Horizon[] {
  const horizons: Horizon[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--as-of") continue;

    const raw = argv[++i] ?? "";

    if (raw === "now") {
      horizons.push({ label: "now" });
      continue;
    }

    const ms = Date.parse(raw);

    if (Number.isNaN(ms)) throw new Error(`--as-of ${raw}: not an ISO-8601 instant or "now"`);

    horizons.push({ label: raw, asOf: new Date(ms).toISOString() });
  }

  return horizons.length ? horizons : [{ label: "now" }];
}

function num(argv: string[], name: string, fallback: number): number {
  const i = argv.indexOf(name);
  const parsed = i < 0 ? NaN : Number(argv[i + 1]);

  return Number.isFinite(parsed) ? parsed : fallback;
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

// How often the returned section (best_chunk's heading) matches one of the gold
// section labels for a returned gold node.
function sectionAccuracy(
  ranked: { id: string; section?: string }[],
  gold: Set<string>,
  sections: Map<string, Set<string>> | undefined,
  k: number,
): number {
  if (!sections || sections.size === 0) return NaN;

  let possible = 0;
  let hits = 0;

  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    const r = ranked[i]!;
    if (gold.has(r.id)) {
      const goldSecs = sections.get(r.id);
      if (goldSecs && goldSecs.size > 0) {
        possible++;
        const rSec = sectionName(r.section ?? null);
        if (
          [...goldSecs].some((s) => matchesSection(r.section ?? null, s) || matchesSection(s, rSec))
        ) {
          hits++;
        }
      }
    }
  }

  return possible > 0 ? hits / possible : NaN;
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
      parent_node_id: null,
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
async function goldFromEvents(rows: Rows): Promise<{
  entries: GoldEntry[];
  searches: number;
  sectionLabels: number;
}> {
  const events = await rows<{ session_id: string; action: string; detail: string }>(
    `SELECT session_id, action, detail FROM events
     WHERE action IN ('search','get') AND detail LIKE '%"ids"%'
     ORDER BY session_id, ts, id`,
  );

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

  for (const row of events) {
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

// A label is only worth scoring while the node it points at is live at the horizon: an
// invalidated or merged-away node cannot be returned, so keeping it would score a correct
// ranking as a miss.
async function nodeSpans(rows: Rows): Promise<Map<string, NodeSpan>> {
  const found = await rows<{ id: string; created_at: string; invalidated_at: string | null }>(
    "SELECT id, created_at, invalidated_at FROM nodes",
  );

  return new Map(
    found.map((r) => [r.id, { created: r.created_at, invalidated: r.invalidated_at }]),
  );
}

function redacted(url: string): string {
  const parsed = new URL(url);

  if (parsed.password) parsed.password = "***";

  return parsed.toString();
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

interface Shared {
  db: Database.Database | null;
  base: Record<string, string>;
  provider: EmbeddingProvider;
  readonly: boolean;
  mode?: "hybrid" | "text" | "vector";
  kinds?: MemoryKind[];
}

// A fresh container per arm so every config section is rebuilt from the arm's overlay,
// sharing the embeddings — and, on SQLite, the DB — so only the knob differs.
function armScope(arm: Arm, shared: Shared): DependencyContainer {
  const scope = container.createChildContainer();

  buildContainer({
    role: shared.readonly ? "cli" : "server",
    source: new LayeredConfigSource(
      new StaticConfigSource(arm.env),
      new StaticConfigSource(shared.base),
      new EnvConfigSource(),
    ),
    into: scope,
  });
  if (shared.db !== null) scope.register(DB_TOKEN, { useValue: shared.db });

  // An arm that names its own embedding model embeds its queries with it.
  if (!("MEMORY_EMBED_MODEL" in arm.env) && !("MEMORY_EMBED_PROVIDER" in arm.env)) {
    scope.register(EMBEDDING_PROVIDER_TOKEN, { useValue: shared.provider });
  }

  // `search` normally touches the session table through HintsService. Against a real store
  // this eval must not write a single byte, so the hint source is stubbed out and the tool
  // is invoked directly, below the audit decorator that would otherwise log an event.
  if (shared.readonly) {
    scope.register(HintsService, {
      useValue: { getSessionHints: () => Promise.resolve([]) } as unknown as HintsService,
    });
  }

  return scope;
}

async function runArm(
  scope: DependencyContainer,
  queries: EvalQuery[],
  shared: Shared,
  facetOf: Map<string, string>,
  asOf: string | undefined,
): Promise<Scores> {
  const tool = scope.resolve(SearchTool);
  const sid = shared.readonly
    ? "eval-readonly"
    : (await scope.resolve(SessionStartTool).invoke({})).session_id;
  const scores: Scores = { rr: [], ndcg: [], p1: [], recall: [], facets: [], secAcc: [] };

  for (const q of queries) {
    const res = await tool.invoke({
      session_id: sid,
      query: q.query,
      limit: K,
      ...(shared.mode === undefined ? {} : { mode: shared.mode }),
      ...(shared.kinds === undefined ? {} : { kinds: shared.kinds }),
      ...(asOf === undefined ? {} : { as_of: asOf }),
    });
    const ranked = res.results.map((r) => r.id);
    const facet = facetCoverage(ranked, q.gold, facetOf, FACET_K);
    const secAcc = sectionAccuracy(res.results, q.gold, q.sections, K);

    scores.rr.push(reciprocalRank(ranked, q.gold));
    scores.ndcg.push(ndcgAtK(ranked, q.gold, K));
    scores.p1.push(precisionAt1(ranked, q.gold));
    scores.recall.push(recallAtK(ranked, q.gold, K));

    if (!Number.isNaN(facet)) scores.facets.push(facet);
    if (!Number.isNaN(secAcc)) scores.secAcc.push(secAcc);
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
  const store = argv.includes("--db") ? argv[argv.indexOf("--db") + 1] : undefined;
  const pgUrl = argv.includes("--pg") ? argv[argv.indexOf("--pg") + 1] : undefined;
  const readonly = !!store || !!pgUrl;
  const base: Record<string, string> = pgUrl
    ? { MEMORY_STORE_BACKEND: "postgres", MEMORY_PG_URL: pgUrl }
    : { MEMORY_DB_PATH: store ?? ":memory:" };
  const mode = argv.includes("--mode")
    ? (argv[argv.indexOf("--mode") + 1] as "hybrid" | "text" | "vector")
    : undefined;
  const kinds = argv.includes("--kinds")
    ? (argv[argv.indexOf("--kinds") + 1]!.split(",") as MemoryKind[])
    : undefined;
  const floor = argv.includes("--min")
    ? Number(argv[argv.indexOf("--min") + 1] ?? MIN_GOLD_QUERIES)
    : MIN_GOLD_QUERIES;

  // Against a real store the DB is opened through the `cli` role, which is read-only.
  const root = buildContainer({
    role: readonly ? "cli" : "server",
    source: new LayeredConfigSource(new StaticConfigSource(base), new EnvConfigSource()),
    into: container.createChildContainer(),
  });

  const db = pgUrl ? null : root.resolve<Database.Database>(DB_TOKEN);
  const provider = root.resolve<EmbeddingProvider>(EMBEDDING_PROVIDER_TOKEN);
  const shared: Shared = { db, base, provider, readonly, mode, kinds };
  const scopes = arms.map((arm) => armScope(arm, shared));
  const horizons = parseHorizons(argv);
  const runs: Run[] = [];
  let spans = new Map<string, NodeSpan>();
  let facetOf = new Map<string, string>();

  if (!readonly && horizons.some((h) => h.asOf !== undefined)) {
    console.error("--as-of needs a real store (--db or --pg)");
    process.exitCode = 1;
    return;
  }

  console.log(`embeddings: ${provider.name}`);

  if (readonly) {
    const { entries: mined, searches, sectionLabels } = await goldFromEvents(rowsOf(root));
    const goldPath = argv.includes("--gold") ? argv[argv.indexOf("--gold") + 1] : undefined;
    const fromFile = goldPath ? readGoldFile(goldPath) : { entries: [], malformed: 0 };
    const origins = parseOrigins(
      argv.includes("--origin") ? argv[argv.indexOf("--origin") + 1] : undefined,
    );
    const entries = filterByOrigin([...fromFile.entries, ...mined], origins);
    const storeSpans = [
      await nodeSpans(rowsOf(root)),
      ...(await Promise.all(scopes.map((scope) => nodeSpans(rowsOf(scope))))),
    ];
    const counts = countByOrigin(entries);

    spans = storeSpans[0]!;

    console.log(`store: ${pgUrl ? redacted(pgUrl) : store} (read-only)`);

    if (goldPath) {
      console.log(
        `gold file: ${goldPath} — ${fromFile.entries.length} entries${fromFile.malformed ? `, ${fromFile.malformed} malformed lines skipped` : ""}`,
      );
    }

    console.log(
      `retrieval-outcome log: ${mined.length} queries with a fetch, out of ${searches} logged searches`,
    );
    console.log(
      `labels: ${entries.length} entries (generated ${counts.generated}, adjudicated ${counts.adjudicated}, mined ${counts.mined}), ` +
        `${sectionLabels} query→node→section labels from the log`,
    );

    for (const horizon of horizons) {
      const { kept, droppedLabels, droppedQueries } = pruneStale(entries, (id) =>
        storeSpans.every((s) => liveAt(s.get(id), horizon.asOf)),
      );
      const queries = sample(toEvalQueries(kept), num(argv, "--sample", Infinity));
      const pairs = queries.reduce((n, q) => n + q.gold.size, 0);

      console.log(
        `${horizon.label}: scoring ${queries.length} distinct queries, ${pairs} query→node pairs` +
          (droppedLabels
            ? `; dropped ${droppedLabels} labels on nodes not live ${horizon.asOf ? "then" : "any more"} (${droppedQueries} queries lost every label)`
            : ""),
      );

      if (queries.length < floor) {
        console.log(`  below the floor of ${floor} queries, not scored`);
        continue;
      }

      runs.push({ horizon, queries });
    }

    if (!runs.length) {
      console.log(
        `\nNot enough labelled data to measure anything: ${floor} usable queries is the floor.\n` +
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

    runs.push({
      horizon: horizons[0]!,
      queries: data.queries.map((q) => ({
        query: q.query,
        gold: new Set(
          q.relevant
            .map((datasetId) => byTitle.get(titleOf.get(datasetId) ?? ""))
            .filter((x): x is string => !!x),
        ),
        origins: new Set<never>(),
      })),
    });
    facetOf = new Map(
      data.docs
        .filter((d) => d.facet)
        .map((d) => [byTitle.get(d.title) ?? d.id, d.facet!] as const),
    );
  }

  const dumpPath = argv.includes("--dump") ? argv[argv.indexOf("--dump") + 1] : undefined;

  if (dumpPath) writeFileSync(dumpPath, "");

  for (const run of runs) {
    console.log(`\n=== as of ${run.horizon.label} ===`);

    const table = await scoreRun(run, arms, scopes, shared, facetOf);

    if (spans.size) printAges(run, table, spans);
    if (dumpPath) dumpRun(dumpPath, run, table);
  }
}

function dumpRun(path: string, run: Run, table: Table): void {
  const perArm = (pick: (scores: Scores) => number[], i: number) =>
    Object.fromEntries(table.map((row) => [row.arm.name, pick(row.scores)[i]]));
  const lines = run.queries.map((q, i) =>
    JSON.stringify({
      horizon: run.horizon.label,
      query: q.query,
      gold: [...q.gold],
      ndcg: perArm((s) => s.ndcg, i),
      rr: perArm((s) => s.rr, i),
    }),
  );

  appendFileSync(path, lines.join("\n") + "\n", "utf8");
}

type Table = { arm: Arm; scores: Scores }[];

async function scoreRun(
  run: Run,
  arms: Arm[],
  scopes: DependencyContainer[],
  shared: Shared,
  facetOf: Map<string, string>,
): Promise<Table> {
  console.log(
    `arm          |   MRR | nDCG@${K} |   P@1 | Rec@${K} | Facet@${FACET_K} | SecAcc@${K}`,
  );
  console.log("-------------+-------+---------+-------+--------+---------+----------");

  const table: Table = [];

  for (const [i, arm] of arms.entries()) {
    const scores = await runArm(scopes[i]!, run.queries, shared, facetOf, run.horizon.asOf);

    table.push({ arm, scores });
    console.log(
      `${arm.name.padEnd(12)} | ${pct(mean(scores.rr))} | ${pct(mean(scores.ndcg))}   | ${pct(mean(scores.p1))} | ${pct(mean(scores.recall))}  | ${pct(mean(scores.facets))}   | ${pct(mean(scores.secAcc))}`,
    );
  }

  if (table.length > 1) {
    const first = table[0]!;

    console.log(`\ndeltas vs '${first.arm.name}' (percentage points, 95% band):`);

    const signed = (x: number) =>
      Number.isNaN(x) ? "-" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}`;
    const d = (a: number[], b: number[]) => signed(mean(b) - mean(a));
    const band = (a: number[], b: number[]) => {
      const { delta, low, high } = pairedBootstrap(a, b);

      return `${signed(delta)} [${signed(low)}, ${signed(high)}]`;
    };

    for (const row of table.slice(1)) {
      console.log(
        `  ${row.arm.name.padEnd(12)} nDCG ${band(first.scores.ndcg, row.scores.ndcg)}   MRR ${band(first.scores.rr, row.scores.rr)}   Rec ${d(first.scores.recall, row.scores.recall)}   Facet ${d(first.scores.facets, row.scores.facets)}   SecAcc ${d(first.scores.secAcc, row.scores.secAcc)}`,
      );
    }
  }

  return table;
}

function printAges(run: Run, table: Table, spans: Map<string, NodeSpan>): void {
  const at = run.horizon.asOf ?? new Date().toISOString();
  const buckets = run.queries.map((q) => queryAge(q.gold, spans, at));

  console.log(`\nnDCG@${K} by age of the youngest answer:`);
  console.log(`age     |    n | ${table.map((row) => row.arm.name.padEnd(12)).join(" | ")}`);

  for (const { label } of AGE_BUCKETS) {
    const picked = buckets.flatMap((bucket, i) => (bucket === label ? [i] : []));

    if (!picked.length) continue;

    const cells = table.map((row) => pct(mean(picked.map((i) => row.scores.ndcg[i]!))).padEnd(12));

    console.log(`${label.padEnd(7)} | ${String(picked.length).padStart(4)} | ${cells.join(" | ")}`);
  }
}

main().catch((e: unknown) => {
  console.error("eval failed:", e);
  process.exit(1);
});
