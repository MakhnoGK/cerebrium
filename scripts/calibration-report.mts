#!/usr/bin/env node
import "reflect-metadata";
import type Database from "better-sqlite3";
import { SearchRepo } from "@/db/repositories";
import { DB_TOKEN } from "@/db/repositories/base";
import { chunkContent } from "@/core/chunk";
import { toFtsMatch } from "@/core/fts";
import { buildContainer } from "@/container";
import {
  ConsolidationThresholdsConfig,
  DatabaseConfig,
  RetrievalConfig,
} from "@/infrastructure/config";

// Threshold calibration report: `npm run calibrate:report`. Answers "where should the
// similarity gates sit" with measurements from the real store instead of intuition, and
// keeps the answer re-derivable after a corpus grows or an embedding model is swapped
// (the constants are specific to both). Read-only — opens the DB via the `cli` role, so
// it never touches migrations and never becomes a second writer.
//
// Two arms, because only one gate has labels:
//   labelled — `consolidation_candidates` records the operator's own applied/dismissed
//     verdicts on merge pairs. That is a ground-truth set: score the pairs, measure how
//     well each candidate scorer separates the two classes (AUC), and print the
//     precision/recall trade at each threshold.
//   density — the dedup probe and link discovery have no verdicts, so they are calibrated
//     against a target *volume* instead: how many candidates would a write surface, and
//     how many edges would link discovery propose per node.
//
// Flags: --json, --all-scorers (also run the scorers already rejected by measurement),
// --help.

const MERGE_SWEEP = [0.9, 0.905, 0.91, 0.915, 0.92, 0.925, 0.93, 0.935, 0.94, 0.945, 0.95];
const DENSITY_SWEEP = [0.85, 0.87, 0.89, 0.9, 0.91, 0.92, 0.925, 0.93, 0.94];

// Jaccard overlap, not cosine: the lexical fallback lives on its own scale.
const LEXICAL_SWEEP = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.7, 0.9];

// The read-time fold gate (L2.2). Its own scale: `search` compares one vector per node —
// the lowest-seq chunk, what `SearchRepo.vectorsFor` returns — while the merge detector
// scores a node's seed chunk against the other node's NEAREST chunk. The two disagree, so
// a fold gate must never be read off `mergeSim`.
const FOLD_SWEEP = [0.9, 0.91, 0.92, 0.93, 0.94, 0.95, 0.96, 0.97, 0.98];

// A fold hides one result behind another, so the pair it fires on had better be one the
// operator would have merged.
const TARGET_FOLD_PRECISION = 0.95;

// Below this, the scorer is not ranking the labelled classes at all, and no threshold read
// off it means anything. Reporting a bare "—" there reads as "not enough data yet", which
// is a different and much more hopeful problem than the one being measured.
const CHANCE_AUC = 0.6;

// The burst rule, measured at 7/7 against 19% delay: one writer, one moment. At detection
// time it compares node age to the detection instant; there is no such instant at read
// time, so the read-time reading is "written by the same session, within an hour of each
// other". A burst is a series, and a series must not fold.
const BURST_WINDOW_MS = 60 * 60 * 1000;

// Mirrors the per-node neighbour ceiling in ConsolidationRepo.duplicateSemanticPairs.
const CAP_PER_NODE = 10;

// Mirrors DEDUP_CANDIDATES in the write tool.
const DEDUP_CANDIDATES = 5;

// The write tool shows at most this many candidates, so "how many would it surface" is
// capped the same way.
const DEDUP_SHOWN = 3;

// Density targets. A write is not normally a duplicate, so a gate that fires on most
// writes is noise; link discovery wants a graph that is connected but not saturated.
const TARGET_DEDUP_HIT_RATE = 0.15;
const TARGET_LINK_EDGES_PER_NODE = 5;
const TARGET_LEXICAL_HIT_RATE = 0.15;

interface Pair {
  a: string;
  b: string;
  positive: boolean;
  storedScore: number;
}

interface Scored {
  positive: boolean;
  value: number;
}

interface ScorerStats {
  name: string;
  auc: number;
  posMean: number;
  posSd: number;
  negMean: number;
  negSd: number;
  cohensD: number;
}

interface SweepRow {
  threshold: number;
  kept: number;
  precision: number;
  recall: number;
  admittedNegatives: number;
}

interface DedupRow {
  threshold: number;
  hitRate: number;
  meanShown: number;
  p90Shown: number;
}

interface LexicalRow {
  threshold: number;
  hitRate: number;
  meanShown: number;
}

// Each arm is reported twice: on cosine alone, and with the burst rule excluding a pair
// one writer produced in one moment. The second is what L2.2 would actually run.
interface FoldLabelledRow {
  gate: number;
  folded: number;
  precision: number;
  recall: number;
  wrongFolds: number;
  guardedFolded: number;
  guardedPrecision: number;
  guardedRecall: number;
  guardedWrongFolds: number;
}

interface FoldImpactRow {
  gate: number;
  searchesWithFold: number;
  folds: number;
  burstFolds: number;
  guardedSearchesWithFold: number;
  guardedFolds: number;
}

interface Provenance {
  session: string;
  createdAt: number;
}

interface LinkRow {
  threshold: number;
  meanEdges: number;
  p90Edges: number;
  maxEdges: number;
  totalEdges: number;
}

function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write("usage: npm run calibrate:report -- [--json] [--all-scorers]\n");
    return Promise.resolve();
  }

  const container = buildContainer({ role: "cli" });
  const db = container.resolve<Database.Database>(DB_TOKEN);
  const dbPath = container.resolve(DatabaseConfig).path;
  const retrieval = container.resolve(RetrievalConfig);
  const thresholds = container.resolve(ConsolidationThresholdsConfig);
  const searchRepo = container.resolve(SearchRepo);

  const asJson = process.argv.includes("--json");
  const allScorers = process.argv.includes("--all-scorers");

  return report({
    db,
    dbPath,
    searchRepo,
    live: {
      dedupThreshold: retrieval.dedupThreshold,
      sim: thresholds.sim,
      mergeSim: thresholds.mergeSim,
    },
    asJson,
    allScorers,
  });
}

async function report(opts: {
  db: Database.Database;
  dbPath: string;
  searchRepo: SearchRepo;
  live: { dedupThreshold: number; sim: number; mergeSim: number };
  asJson: boolean;
  allScorers: boolean;
}): Promise<void> {
  const { db, live } = opts;
  const vectors = loadSemanticVectors(db);
  const pairs = loadLabelledPairs(db, vectors);
  const scorers = await buildScorers(db, vectors, pairs, opts.allScorers);

  const stats = scorers.map(({ name, scored }) => scorerStats(name, scored));
  const sweep = thresholdSweep(pairs, MERGE_SWEEP);
  const fidelity = storedVsRecomputed(pairs, vectors);
  const dedup = dedupDensity(db, opts.searchRepo, vectors, DENSITY_SWEEP);
  const link = linkDensity(db, vectors, DENSITY_SWEEP);
  const lexical = lexicalDensity(db, opts.searchRepo, LEXICAL_SWEEP);

  const firstChunk = loadFirstChunkVectors(db);
  const prov = loadProvenance(db);
  const foldLabelledRows = foldLabelled(pairs, firstChunk, prov, FOLD_SWEEP);
  const foldImpactArm = foldImpact(db, firstChunk, prov, FOLD_SWEEP);
  const foldGate = foldRecommendation(foldLabelledRows);

  if (opts.asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          db_path: opts.dbPath,
          live_thresholds: live,
          corpus: { semantic_nodes: vectors.size, labelled_pairs: pairs.length },
          fidelity,
          scorers: stats,
          merge_sweep: sweep,
          dedup_density: dedup,
          lexical_density: lexical,
          link_density: link,
          fold_labelled: foldLabelledRows,
          fold_impact: { searches: foldImpactArm.searches, sweep: foldImpactArm.rows },
          recommendation: { ...recommendation(sweep, dedup, link, lexical), foldSim: foldGate },
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  const L: string[] = [];
  const pos = pairs.filter((p) => p.positive).length;

  L.push(`cerebrium calibration report   ${opts.dbPath}`);
  L.push("");
  L.push(
    `corpus: ${vectors.size} semantic nodes with vectors   labelled merge pairs: ${pairs.length} (${pos} applied / ${pairs.length - pos} dismissed)`,
  );
  L.push(
    `live thresholds: dedup ${live.dedupThreshold}   link/cluster ${live.sim}   merge ${live.mergeSim}`,
  );
  L.push("");
  L.push(
    `stored score vs recomputed: mean |Δ| ${fidelity.meanAbsDelta.toFixed(4)}   max |Δ| ${fidelity.maxAbsDelta.toFixed(4)}   (${fidelity.compared} pairs)`,
  );
  L.push("");

  L.push("── Labelled arm: how well does each scorer separate applied from dismissed ──");
  L.push("  scorer                          AUC     applied         dismissed       Cohen's d");
  for (const s of stats) {
    L.push(
      `  ${s.name.padEnd(30)}  ${s.auc.toFixed(3)}   ` +
        `${s.posMean.toFixed(3)}±${s.posSd.toFixed(3)}   ` +
        `${s.negMean.toFixed(3)}±${s.negSd.toFixed(3)}   ${s.cohensD.toFixed(2)}`,
    );
  }
  if (!opts.allScorers) {
    L.push("  (--all-scorers adds the scorers already measured as worse than raw cosine)");
  }
  L.push("");

  L.push("── Merge gate: precision/recall on the stored score ──");
  L.push("  threshold   kept   precision   recall   bad merges admitted");
  for (const r of sweep) {
    const flat = r.threshold < live.mergeSim ? "   <- below the detection gate" : "";
    L.push(
      `  ${r.threshold.toFixed(3)}     ${String(r.kept).padStart(4)}   ` +
        `${r.precision.toFixed(3)}       ${r.recall.toFixed(3)}    ${r.admittedNegatives}${flat}`,
    );
  }
  L.push("  NOTE: every labelled pair already cleared the gate in force when it was");
  L.push("  detected, so recall below that gate is unmeasurable — the recall column is");
  L.push("  recall among *proposed* pairs, not absolute recall, and the marked rows carry");
  L.push("  no information at all (nothing below that gate was ever proposed).");
  L.push("");

  L.push("── Density arm: what a write's dedup probe would surface (no labels) ──");
  L.push("  threshold   writes with a hit   mean shown   p90 shown");
  for (const r of dedup) {
    L.push(
      `  ${r.threshold.toFixed(3)}     ${(r.hitRate * 100).toFixed(1).padStart(8)}%          ` +
        `${r.meanShown.toFixed(2)}         ${r.p90Shown}`,
    );
  }
  L.push("");

  L.push("── Density arm: the lexical fallback, on its own Jaccard scale ──");
  L.push("  threshold   writes with a hit   mean shown");
  for (const r of lexical) {
    L.push(
      `  ${r.threshold.toFixed(3)}     ${(r.hitRate * 100).toFixed(1).padStart(8)}%          ` +
        r.meanShown.toFixed(2),
    );
  }
  L.push("  This path only runs when nothing is embedded yet, and Jaccard is not cosine: a");
  L.push("  paraphrased duplicate scores ~0.18 here, a verbatim copy ~1.0.");
  L.push("");

  L.push("── Density arm: edges per node link discovery would propose, from scratch ──");
  L.push("  threshold   mean/node   p90/node   max/node   total");
  for (const r of link) {
    L.push(
      `  ${r.threshold.toFixed(3)}     ${r.meanEdges.toFixed(2)}        ` +
        `${String(r.p90Edges).padStart(3)}        ${String(r.maxEdges).padStart(3)}       ${r.totalEdges}`,
    );
  }
  L.push("  Existing similar_to edges are ignored here: this measures the rule, not the");
  L.push("  incremental delta against a graph the old rule already saturated. Candidates come");
  L.push("  from an exhaustive scan of the semantic tier rather than production's k=20 chunk");
  L.push("  KNN, so these counts are an upper bound — the safe direction for a density gate.");
  L.push("");

  L.push("── Fold gate, labelled arm: would folding this pair have hidden a note? ──");
  L.push("                cosine alone                      with the burst rule");
  L.push("  gate    folds  precision  recall  wrong   folds  precision  recall  wrong");
  for (const r of foldLabelledRows) {
    L.push(
      `  ${r.gate.toFixed(3)}  ${String(r.folded).padStart(5)}  ${r.precision.toFixed(3)}      ` +
        `${r.recall.toFixed(3)}  ${String(r.wrongFolds).padStart(5)}   ` +
        `${String(r.guardedFolded).padStart(5)}  ${r.guardedPrecision.toFixed(3)}      ` +
        `${r.guardedRecall.toFixed(3)}  ${String(r.guardedWrongFolds).padStart(5)}`,
    );
  }
  L.push("  Labels are the operator's own merge verdicts: applied = one slot was enough,");
  L.push("  dismissed = two notes that each deserved one. Nothing below `mergeSim` was ever");
  L.push("  proposed, so this arm cannot see pairs the detector never surfaced — the same");
  L.push("  blind spot the merge sweep has, and the reason recall here is recall among");
  L.push("  proposed pairs. Scored on first-chunk cosine, NOT on the detector's stored");
  L.push("  score: `search` compares one vector per node, the detector compares a seed");
  L.push("  chunk against the nearest one. Do not read a fold gate off `mergeSim`.");
  L.push("");

  L.push("── Fold gate, impact arm: replayed over the result sets real searches returned ──");
  L.push(`  ${foldImpactArm.searches} logged searches returned more than one result`);
  L.push("               cosine alone                with the burst rule");
  L.push("  gate    searches with a fold  folds   searches with a fold  folds");
  for (const r of foldImpactArm.rows) {
    L.push(
      `  ${r.gate.toFixed(3)}   ${String(r.searchesWithFold).padStart(7)} ` +
        `${pctOf(r.searchesWithFold, foldImpactArm.searches)}  ${String(r.folds).padStart(5)}   ` +
        `${String(r.guardedSearchesWithFold).padStart(13)} ` +
        `${pctOf(r.guardedSearchesWithFold, foldImpactArm.searches)}  ${String(r.guardedFolds).padStart(5)}`,
    );
  }
  L.push("  A result folds only against one already kept, never transitively — the rule that");
  L.push("  stops a fold chaining the way single-linkage clustering does on this corpus.");
  L.push("");

  const rec = recommendation(sweep, dedup, link, lexical);
  const production = stats.find((row) => row.name.includes("production"));
  const atChance = production !== undefined && production.auc < CHANCE_AUC;
  L.push("── Suggested thresholds ──");
  L.push(
    `  fold    ${foldGate ?? "—"}   (lowest gate at >=${TARGET_FOLD_PRECISION} labelled precision with no series folded)`,
  );
  L.push(
    rec.mergeSim === null && atChance
      ? `  merge   —   (cosine ranks applied vs dismissed at AUC ${production.auc.toFixed(3)}, i.e. chance: ` +
          `no threshold on this scorer carries the decision, so the gate is volume control and the judge is the discriminator)`
      : `  merge   ${rec.mergeSim ?? "—"}   (highest precision at >=0.95, preferring recall on ties)`,
  );
  L.push(
    `  dedup   ${rec.dedupThreshold ?? "—"}   (lowest threshold with <=${(TARGET_DEDUP_HIT_RATE * 100).toFixed(0)}% of writes surfacing a hit)`,
  );
  L.push(
    `  lexical ${rec.lexicalDedupThreshold ?? "—"}   (lowest Jaccard threshold with <=${(TARGET_LEXICAL_HIT_RATE * 100).toFixed(0)}% of writes surfacing a hit)`,
  );
  L.push(
    `  link    ${rec.sim ?? "—"}   (lowest threshold with <=${TARGET_LINK_EDGES_PER_NODE} proposed edges per node)`,
  );
  if (rec.orderingAdjusted) {
    L.push("  dedup was lowered one step: the density target alone landed at or above merge,");
    L.push("  and mergeSim is documented as the stricter of the two.");
  }

  process.stdout.write(L.join("\n") + "\n");
}

// ---- corpus -----------------------------------------------------------------

interface NodeVectors {
  seed: Float64Array | null;
  all: Float64Array[];
}

// Semantic nodes only (the gates never consider mirrors), invalidated included: the
// members of an applied merge are invalidated by definition, and their chunks survive.
function loadSemanticVectors(db: Database.Database): Map<string, NodeVectors> {
  const rows = db
    .prepare(
      `SELECT c.node_id AS node_id, c.seq AS seq, vec_to_json(v.embedding) AS embedding
       FROM chunks c
       JOIN chunk_vec v ON v.chunk_id = c.id
       JOIN nodes n ON n.id = c.node_id
       WHERE c.stale = 0 AND n.memory_kind = 'semantic'
       ORDER BY c.node_id, c.seq`,
    )
    .all() as { node_id: string; seq: number; embedding: string }[];

  const out = new Map<string, NodeVectors>();
  for (const row of rows) {
    const vec = Float64Array.from(JSON.parse(row.embedding) as number[]);
    const entry = out.get(row.node_id) ?? { seed: null, all: [] };
    entry.seed ??= vec;
    entry.all.push(vec);
    out.set(row.node_id, entry);
  }
  return out;
}

function loadLabelledPairs(db: Database.Database, vectors: Map<string, NodeVectors>): Pair[] {
  const rows = db
    .prepare(
      `SELECT status, member_ids, score FROM consolidation_candidates
       WHERE kind = 'merge' AND status IN ('applied','dismissed')`,
    )
    .all() as { status: string; member_ids: string; score: number }[];

  const out: Pair[] = [];
  let skipped = 0;
  for (const row of rows) {
    const members = JSON.parse(row.member_ids) as string[];
    const [a, b] = members;
    if (members.length !== 2 || a === undefined || b === undefined) {
      skipped++;
      continue;
    }
    if (!vectors.has(a) || !vectors.has(b)) {
      skipped++;
      continue;
    }
    out.push({ a, b, positive: row.status === "applied", storedScore: row.score });
  }
  if (skipped) {
    process.stderr.write(`skipped ${skipped} labelled candidates (not a 2-member vector pair)\n`);
  }
  return out;
}

// ---- scorers ----------------------------------------------------------------

async function buildScorers(
  db: Database.Database,
  vectors: Map<string, NodeVectors>,
  pairs: Pair[],
  allScorers: boolean,
): Promise<{ name: string; scored: Scored[] }[]> {
  const of = (name: string, score: (p: Pair) => number) => ({
    name,
    scored: pairs.map((p) => ({ positive: p.positive, value: score(p) })),
  });

  const out = [
    of("raw cosine (production)", (p) => p.storedScore),
    of("raw cosine (recomputed)", (p) => productionSim(vectors, p.a, p.b)),
  ];

  if (allScorers) {
    const mean = corpusMean(vectors);
    const dist = neighbourDistributions(vectors);
    const text = loadText(db);
    const tokens = new Map([...text].map(([id, t]) => [id, tokenSet(`${t.title} ${t.content}`)]));
    const titles = new Map([...text].map(([id, t]) => [id, tokenSet(t.title)]));

    out.push(
      of("centered cosine (REJECTED)", (p) => centeredSim(vectors, mean, p.a, p.b)),
      of("z-score, min side (REJECTED)", (p) =>
        Math.min(zScore(vectors, dist, p.a, p.b), zScore(vectors, dist, p.b, p.a)),
      ),
      of("z-score, max side (REJECTED)", (p) =>
        Math.max(zScore(vectors, dist, p.a, p.b), zScore(vectors, dist, p.b, p.a)),
      ),
      of("title jaccard (REJECTED)", (p) => jaccard(titles.get(p.a), titles.get(p.b))),
      of("content jaccard (REJECTED)", (p) => jaccard(tokens.get(p.a), tokens.get(p.b))),
    );
  }

  return out;
}

// Mirrors ConsolidationRepo.nearestSemantic: seeded by the node's lowest-seq chunk,
// scored against the neighbour's nearest chunk. Asymmetric by construction, so the
// report takes the same direction the daemon would.
function productionSim(vectors: Map<string, NodeVectors>, a: string, b: string): number {
  const seed = vectors.get(a)?.seed;
  const other = vectors.get(b)?.all;
  if (!seed || !other?.length) return 0;
  let best = -1;
  for (const v of other) best = Math.max(best, cosine(seed, v));
  return best;
}

function storedVsRecomputed(
  pairs: Pair[],
  vectors: Map<string, NodeVectors>,
): { compared: number; meanAbsDelta: number; maxAbsDelta: number } {
  let sum = 0;
  let max = 0;
  for (const p of pairs) {
    const delta = Math.abs(productionSim(vectors, p.a, p.b) - p.storedScore);
    sum += delta;
    max = Math.max(max, delta);
  }
  return {
    compared: pairs.length,
    meanAbsDelta: pairs.length ? sum / pairs.length : 0,
    maxAbsDelta: max,
  };
}

function corpusMean(vectors: Map<string, NodeVectors>): Float64Array {
  const all = [...vectors.values()].flatMap((v) => v.all);
  const dim = all[0]?.length ?? 0;
  const mean = new Float64Array(dim);
  for (const v of all) {
    for (let i = 0; i < dim; i++) mean[i] = (mean[i] ?? 0) + (v[i] ?? 0);
  }
  if (all.length) {
    for (let i = 0; i < dim; i++) mean[i] = (mean[i] ?? 0) / all.length;
  }
  return mean;
}

function centeredSim(
  vectors: Map<string, NodeVectors>,
  mean: Float64Array,
  a: string,
  b: string,
): number {
  const seed = vectors.get(a)?.seed;
  const other = vectors.get(b)?.all;
  if (!seed || !other?.length) return 0;
  const centeredSeed = subtract(seed, mean);
  let best = -1;
  for (const v of other) best = Math.max(best, cosine(centeredSeed, subtract(v, mean)));
  return best;
}

// Per-node neighbour similarity distribution, trimming the top 5% so that a node's own
// duplicates do not inflate the baseline they are being compared against.
function neighbourDistributions(
  vectors: Map<string, NodeVectors>,
): Map<string, { mean: number; sd: number }> {
  const ids = [...vectors.keys()];
  const out = new Map<string, { mean: number; sd: number }>();
  for (const a of ids) {
    const sims = ids
      .filter((b) => b !== a)
      .map((b) => productionSim(vectors, a, b))
      .sort((x, y) => y - x)
      .slice(Math.ceil(ids.length * 0.05));
    if (!sims.length) {
      out.set(a, { mean: 0, sd: 0 });
      continue;
    }
    const mean = sims.reduce((t, x) => t + x, 0) / sims.length;
    const sd = Math.sqrt(sims.reduce((t, x) => t + (x - mean) ** 2, 0) / sims.length);
    out.set(a, { mean, sd });
  }
  return out;
}

function zScore(
  vectors: Map<string, NodeVectors>,
  dist: Map<string, { mean: number; sd: number }>,
  a: string,
  b: string,
): number {
  const d = dist.get(a);
  if (!d || d.sd === 0) return 0;
  return (productionSim(vectors, a, b) - d.mean) / d.sd;
}

function loadText(db: Database.Database): Map<string, { title: string; content: string }> {
  const rows = db
    .prepare(
      `SELECT n.id AS id, n.title AS title, lr.content AS content
       FROM nodes n
       JOIN (SELECT node_id, MAX(rev) AS mrev FROM revisions GROUP BY node_id) m ON m.node_id = n.id
       JOIN revisions lr ON lr.node_id = n.id AND lr.rev = m.mrev
       WHERE n.memory_kind = 'semantic'`,
    )
    .all() as { id: string; title: string; content: string }[];
  return new Map(rows.map((r) => [r.id, { title: r.title, content: r.content }]));
}

// ---- metrics ----------------------------------------------------------------

function scorerStats(name: string, scored: Scored[]): ScorerStats {
  const pos = scored.filter((s) => s.positive).map((s) => s.value);
  const neg = scored.filter((s) => !s.positive).map((s) => s.value);
  const posSd = sd(pos);
  const negSd = sd(neg);
  const pooled = Math.sqrt((posSd ** 2 + negSd ** 2) / 2);
  return {
    name,
    auc: auc(pos, neg),
    posMean: mean(pos),
    posSd,
    negMean: mean(neg),
    negSd,
    cohensD: pooled === 0 ? 0 : (mean(pos) - mean(neg)) / pooled,
  };
}

// Mann-Whitney U / P(random positive scores above random negative), ties at 0.5.
function auc(pos: number[], neg: number[]): number {
  if (!pos.length || !neg.length) return 0;
  let wins = 0;
  for (const p of pos) {
    for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  }
  return wins / (pos.length * neg.length);
}

function thresholdSweep(pairs: Pair[], sweep: number[]): SweepRow[] {
  const positives = pairs.filter((p) => p.positive).length;
  return sweep.map((threshold) => {
    const kept = pairs.filter((p) => p.storedScore >= threshold);
    const tp = kept.filter((p) => p.positive).length;
    return {
      threshold,
      kept: kept.length,
      precision: kept.length ? tp / kept.length : 0,
      recall: positives ? tp / positives : 0,
      admittedNegatives: kept.length - tp,
    };
  });
}

// ---- density ----------------------------------------------------------------

// Replays the write tool's *lexical fallback* — the path taken when nothing is embedded
// yet. Same probe text, same FTS candidates, same Jaccard, so the gate it suggests is on
// the scale the fallback actually produces rather than the cosine scale it used to share.
function lexicalDensity(
  db: Database.Database,
  searchRepo: SearchRepo,
  sweep: number[],
): LexicalRow[] {
  const nodes = db
    .prepare(
      `SELECT n.id AS id, n.project AS project FROM nodes n
       WHERE n.memory_kind = 'semantic' AND n.invalidated_at IS NULL`,
    )
    .all() as { id: string; project: string | null }[];
  const text = loadText(db);

  const perProbe: number[][] = [];
  for (const node of nodes) {
    const own = text.get(node.id);
    if (!own) continue;
    const firstChunk = chunkContent("probe", own.content)[0]?.text ?? own.content;
    const probe = `${own.title}\n${firstChunk}`;
    const match = toFtsMatch(probe);
    if (!match) continue;

    const probeTokens = tokenSet(probe);
    const scores = searchRepo
      .search({
        match,
        project: node.project ?? undefined,
        kinds: ["semantic"],
        history: false,
        cap: DEDUP_CANDIDATES,
      })
      .rows.filter((r) => r.id !== node.id)
      .map((r) => jaccard(probeTokens, tokenSet(`${r.title} ${r.content}`)));
    perProbe.push(scores);
  }

  return sweep.map((threshold) => {
    const shown = perProbe.map(
      (scores) => scores.filter((s) => s >= threshold).slice(0, DEDUP_SHOWN).length,
    );
    return {
      threshold,
      hitRate: shown.length ? shown.filter((n) => n > 0).length / shown.length : 0,
      meanShown: mean(shown),
    };
  });
}

// Replays the write tool's probe for every live semantic node: its own seed vector as the
// query, the same filters and cap, itself excluded. Uses SearchRepo, so the measurement
// inherits the production post-filter behaviour rather than an idealised version of it.
function dedupDensity(
  db: Database.Database,
  searchRepo: SearchRepo,
  vectors: Map<string, NodeVectors>,
  sweep: number[],
): DedupRow[] {
  const probes = db
    .prepare(
      `SELECT n.id AS id, n.project AS project FROM nodes n
       WHERE n.memory_kind = 'semantic' AND n.invalidated_at IS NULL`,
    )
    .all() as { id: string; project: string | null }[];

  const perProbe: number[][] = [];
  for (const probe of probes) {
    const seed = vectors.get(probe.id)?.seed;
    if (!seed) continue;
    const hits = searchRepo
      .vectorSearch([...seed], {
        project: probe.project ?? undefined,
        kinds: ["semantic"],
        history: false,
        cap: DEDUP_CANDIDATES,
      })
      .filter((r) => r.id !== probe.id)
      .map((r) => 1 - r.distance);
    perProbe.push(hits);
  }

  return sweep.map((threshold) => {
    const shown = perProbe.map(
      (hits) => hits.filter((s) => s >= threshold).slice(0, DEDUP_SHOWN).length,
    );
    return {
      threshold,
      hitRate: shown.length ? shown.filter((n) => n > 0).length / shown.length : 0,
      meanShown: mean(shown),
      p90Shown: percentile(shown, 0.9),
    };
  });
}

// ---- fold gate (L2.1) --------------------------------------------------------

// One vector per node, the lowest-seq chunk of an authored node — exactly what
// `SearchRepo.vectorsFor` hands MMR, so the gate this arm recommends is on the scale the
// fold will actually be computed on.
function loadFirstChunkVectors(db: Database.Database): Map<string, Float64Array> {
  const rows = db
    .prepare(
      `SELECT c.node_id AS node_id, vec_to_json(v.embedding) AS embedding
       FROM chunks c
       JOIN chunk_vec v ON v.chunk_id = c.id
       JOIN nodes n ON n.id = c.node_id
       WHERE c.stale = 0 AND n.memory_kind IN ('semantic','episodic')
       ORDER BY c.node_id, c.seq`,
    )
    .all() as { node_id: string; embedding: string }[];

  const out = new Map<string, Float64Array>();
  for (const row of rows) {
    if (out.has(row.node_id)) continue;
    out.set(row.node_id, Float64Array.from(JSON.parse(row.embedding) as number[]));
  }
  return out;
}

function loadProvenance(db: Database.Database): Map<string, Provenance> {
  const rows = db.prepare(`SELECT id, created_by_session, created_at FROM nodes`).all() as {
    id: string;
    created_by_session: string;
    created_at: string;
  }[];

  return new Map(
    rows.map((r) => [r.id, { session: r.created_by_session, createdAt: Date.parse(r.created_at) }]),
  );
}

function isBurst(prov: Map<string, Provenance>, a: string, b: string): boolean {
  const pa = prov.get(a);
  const pb = prov.get(b);
  if (!pa || !pb) return false;

  return pa.session === pb.session && Math.abs(pa.createdAt - pb.createdAt) <= BURST_WINDOW_MS;
}

function foldSim(vectors: Map<string, Float64Array>, a: string, b: string): number | null {
  const va = vectors.get(a);
  const vb = vectors.get(b);

  return va && vb ? cosine(va, vb) : null;
}

// Labelled arm. The operator's own applied/dismissed merge verdicts answer the fold
// question directly: a pair worth merging is a pair worth showing once, and a dismissed
// pair is two notes that each deserve a slot.
function foldLabelled(
  pairs: Pair[],
  vectors: Map<string, Float64Array>,
  prov: Map<string, Provenance>,
  sweep: number[],
): FoldLabelledRow[] {
  const scored = pairs
    .map((p) => ({ ...p, sim: foldSim(vectors, p.a, p.b), burst: isBurst(prov, p.a, p.b) }))
    .filter((p): p is Pair & { sim: number; burst: boolean } => p.sim !== null);
  const positives = scored.filter((p) => p.positive).length;

  return sweep.map((gate) => {
    const folded = scored.filter((p) => p.sim >= gate);
    const right = folded.filter((p) => p.positive).length;
    const guarded = folded.filter((p) => !p.burst);
    const guardedRight = guarded.filter((p) => p.positive).length;

    return {
      gate,
      folded: folded.length,
      precision: folded.length ? right / folded.length : 0,
      recall: positives ? right / positives : 0,
      wrongFolds: folded.length - right,
      guardedFolded: guarded.length,
      guardedPrecision: guarded.length ? guardedRight / guarded.length : 0,
      guardedRecall: positives ? guardedRight / positives : 0,
      guardedWrongFolds: guarded.length - guardedRight,
    };
  });
}

// Impact arm. Replays the fold pass over the result sets real searches actually returned:
// walk the ranked ids, and fold a result only against one already kept — the same
// representative-only rule L2.2 will use, which is what stops a fold chaining.
function foldImpact(
  db: Database.Database,
  vectors: Map<string, Float64Array>,
  prov: Map<string, Provenance>,
  sweep: number[],
): { searches: number; rows: FoldImpactRow[] } {
  const rows = db
    .prepare(`SELECT detail FROM events WHERE action = 'search' AND detail LIKE '%"ids"%'`)
    .all() as { detail: string | null }[];

  const results: string[][] = [];
  for (const row of rows) {
    const ids = idsOf(row.detail);
    if (ids.length > 1) results.push(ids);
  }

  const pass = (ids: string[], gate: number, guard: boolean) => {
    const kept: string[] = [];
    let folded = 0;
    let burst = 0;

    for (const id of ids) {
      const into = kept.find((k) => {
        if ((foldSim(vectors, k, id) ?? 0) < gate) return false;

        return !(guard && isBurst(prov, k, id));
      });

      if (into === undefined) {
        kept.push(id);
        continue;
      }

      folded++;
      if (isBurst(prov, into, id)) burst++;
    }

    return { folded, burst };
  };

  const swept = sweep.map((gate) => {
    let searchesWithFold = 0;
    let folds = 0;
    let burstFolds = 0;
    let guardedSearchesWithFold = 0;
    let guardedFolds = 0;

    for (const ids of results) {
      const raw = pass(ids, gate, false);
      const guarded = pass(ids, gate, true);

      if (raw.folded) searchesWithFold++;
      folds += raw.folded;
      burstFolds += raw.burst;

      if (guarded.folded) guardedSearchesWithFold++;
      guardedFolds += guarded.folded;
    }

    return { gate, searchesWithFold, folds, burstFolds, guardedSearchesWithFold, guardedFolds };
  });

  return { searches: results.length, rows: swept };
}

function idsOf(detail: string | null): string[] {
  if (!detail) return [];

  try {
    const ids = (JSON.parse(detail) as { ids?: unknown }).ids;
    return Array.isArray(ids) ? ids.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function foldRecommendation(labelled: FoldLabelledRow[]): number | null {
  return (
    labelled.find((r) => r.guardedFolded > 0 && r.guardedPrecision >= TARGET_FOLD_PRECISION)
      ?.gate ?? null
  );
}

function linkDensity(
  db: Database.Database,
  vectors: Map<string, NodeVectors>,
  sweep: number[],
): LinkRow[] {
  const seeds = (
    db
      .prepare(
        `SELECT DISTINCT n.id AS id
         FROM nodes n
         JOIN chunks c ON c.node_id = n.id AND c.stale = 0
         JOIN embedding_meta em ON em.chunk_id = c.id
         WHERE n.memory_kind = 'semantic' AND n.invalidated_at IS NULL`,
      )
      .all() as { id: string }[]
  ).map((r) => r.id);

  const live = new Set(seeds);
  const perNode = seeds.map((id) =>
    [...live]
      .filter((other) => other !== id)
      .map((other) => productionSim(vectors, id, other))
      .sort((a, b) => b - a)
      .slice(0, CAP_PER_NODE),
  );

  return sweep.map((threshold) => {
    const counts = perNode.map((sims) => sims.filter((s) => s >= threshold).length);
    return {
      threshold,
      meanEdges: mean(counts),
      p90Edges: percentile(counts, 0.9),
      maxEdges: counts.length ? Math.max(...counts) : 0,
      totalEdges: counts.reduce((t, n) => t + n, 0),
    };
  });
}

function recommendation(
  sweep: SweepRow[],
  dedup: DedupRow[],
  link: LinkRow[],
  lexical: LexicalRow[],
): {
  mergeSim: number | null;
  dedupThreshold: number | null;
  lexicalDedupThreshold: number | null;
  sim: number | null;
  orderingAdjusted: boolean;
} {
  const precise = sweep.filter((r) => r.precision >= 0.95 && r.kept > 0);
  const mergeSim =
    precise.reduce<SweepRow | null>(
      (acc, r) => (acc === null || r.recall > acc.recall ? r : acc),
      null,
    )?.threshold ?? null;

  const byDensity = dedup.find((r) => r.hitRate <= TARGET_DEDUP_HIT_RATE)?.threshold ?? null;

  // ConsolidationThresholdsConfig documents mergeSim as strictly above the dedup probe so
  // merge stays the more conservative gate; the density target alone can violate that.
  const needsAdjusting = byDensity !== null && mergeSim !== null && byDensity >= mergeSim;
  const dedupThreshold = needsAdjusting
    ? ([...dedup].reverse().find((r) => r.threshold < mergeSim)?.threshold ?? byDensity)
    : byDensity;

  return {
    mergeSim,
    dedupThreshold,
    lexicalDedupThreshold:
      lexical.find((r) => r.hitRate <= TARGET_LEXICAL_HIT_RATE)?.threshold ?? null,
    sim: link.find((r) => r.meanEdges <= TARGET_LINK_EDGES_PER_NODE)?.threshold ?? null,
    orderingAdjusted: needsAdjusting,
  };
}

// ---- primitives -------------------------------------------------------------

function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na * nb);
  return denom === 0 ? 0 : dot / denom;
}

function subtract(v: Float64Array, mean: Float64Array): Float64Array {
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] ?? 0) - (mean[i] ?? 0);
  return out;
}

// Matches the write tool's tokenizer exactly; the lexical arm is worthless otherwise.
function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
}

function jaccard(a: Set<string> | undefined, b: Set<string> | undefined): number {
  if (!a?.size || !b?.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((t, x) => t + x, 0) / values.length : 0;
}

function sd(values: number[]): number {
  if (!values.length) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((t, x) => t + (x - m) ** 2, 0) / values.length);
}

function pctOf(part: number, whole: number): string {
  return whole ? `(${((100 * part) / whole).toFixed(1).padStart(5)}%)` : "(    —)";
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

await main();
