#!/usr/bin/env node
import "reflect-metadata";
import {
  coverage,
  GATES,
  inventedNumbers,
  jaccard,
  majorityRate,
  mean,
  percentile,
  terms,
} from "@scripts/role-metrics";
import type Database from "better-sqlite3";
import type {
  AnnotateTask,
  ConsolidationResult,
  ConsolidationTask,
  ReconcileResult,
  ReconcileTask,
} from "@/domain/ports/consolidation-provider";
import {
  ConsolidationRecommendation,
  ReconcileAction,
} from "@/domain/ports/consolidation-provider";
import { HttpConsolidator } from "@/consolidation/http";
import { resolveRoles } from "@/consolidation/roles";
import { DB_TOKEN } from "@/db/repositories/base";
import { ConsolidationKind, GENERATION_ROLES, GenerationRole } from "@/core/vocab";
import { buildContainer } from "@/container";
import { ConsolidationConfig, DatabaseConfig } from "@/infrastructure/config";

// The gate in front of pointing a generation role at a different model: `npm run eval:roles`.
// The embedding gate exists because a model can produce a space that looks fine and is
// noise; the same is true of a judge. Read-only, `cli` role, never a second writer.
//
// `generate` and `reconcile` are scored against the verdicts this store actually recorded:
// a merge/distill candidate an agent APPLIED is a real duplication, one it DISMISSED is a
// series that had to stay apart. `annotate` has no labels, so it is scored on agreement
// with the baseline model plus a faithfulness check the prompt itself demands.
const SAMPLE = 10;
// Wide on purpose: the point is to measure what a call costs, not to re-measure the cap.
const TIMEOUT_MS = 600_000;

interface Labelled {
  id: string;
  kind: ConsolidationKind;
  expectMerge: boolean;
  members: { id: string; title: string; content: string }[];
}

interface Timed<T> {
  ms: number;
  value: T | null;
  error?: string;
}

function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "usage: npm run eval:roles -- --model TAG [--baseline TAG] [--role annotate,reconcile,generate]\n" +
        "                            [--n 10] [--url URL] [--json]\n",
    );

    return Promise.resolve();
  }

  const container = buildContainer({ role: "cli" });
  const config = container.resolve(ConsolidationConfig);
  const candidate = flag("--model");

  if (candidate === undefined) {
    process.stdout.write("pass --model TAG: the model being considered for a role\n");
    process.exitCode = 1;

    return Promise.resolve();
  }

  const roles = (flag("--role") ?? "annotate,reconcile")
    .split(",")
    .map((name) => name.trim())
    .filter((name): name is GenerationRole =>
      (GENERATION_ROLES as readonly string[]).includes(name),
    );

  return report({
    db: container.resolve<Database.Database>(DB_TOKEN),
    dbPath: container.resolve(DatabaseConfig).path,
    baseline: flag("--baseline") ?? config.model,
    candidate,
    url: flag("--url") ?? config.url,
    reconcileCapMs: config.reconcileTimeoutMs,
    roles,
    n: Number(flag("--n") ?? SAMPLE),
    asJson: process.argv.includes("--json"),
  });
}

async function report(opts: {
  db: Database.Database;
  dbPath: string;
  baseline: string;
  candidate: string;
  url: string;
  reconcileCapMs: number;
  roles: GenerationRole[];
  n: number;
  asJson: boolean;
}): Promise<void> {
  const labelled = opts.roles.some((role) => role !== GenerationRole.ANNOTATE)
    ? loadLabelled(opts.db, opts.n)
    : [];
  const records = opts.roles.includes(GenerationRole.ANNOTATE) ? loadRecords(opts.db, opts.n) : [];
  const results: Record<string, unknown> = {};
  let passes = true;

  for (const role of opts.roles) {
    const outcome =
      role === GenerationRole.ANNOTATE
        ? await annotateRole(opts, records)
        : await judgeRole(opts, role, labelled);

    results[role] = outcome;
    passes = passes && outcome.verdict === "pass";
  }

  if (opts.asJson) {
    process.stdout.write(
      `${JSON.stringify({
        db: opts.dbPath,
        baseline: opts.baseline,
        candidate: opts.candidate,
        url: opts.url,
        roles: results,
        verdict: passes ? "pass" : "fail",
      })}\n`,
    );
  } else {
    process.stdout.write(`${render(opts, results, passes)}\n`);
  }

  if (!passes) process.exitCode = 1;
}

// generate / reconcile: both are judgments this store has recorded verdicts for, so both
// are scored the same way — against the label, not against the other model.
async function judgeRole(
  opts: { baseline: string; candidate: string; url: string; reconcileCapMs: number },
  role: GenerationRole,
  labelled: Labelled[],
): Promise<Record<string, unknown> & { verdict: string }> {
  const usable = labelled.filter((row) => row.members.length >= 2);

  if (usable.length < 2) {
    return {
      sampled: usable.length,
      verdict: "skip",
      note: "too few labelled candidates whose members still exist to measure anything",
    };
  }

  const arms = [opts.baseline, opts.candidate].map((model) => ({
    model,
    provider: providerFor(model, opts.url),
    correct: 0,
    failures: 0,
    latency: [] as number[],
    withinCap: 0,
  }));

  for (const row of usable) {
    for (const arm of arms) {
      const timed =
        role === GenerationRole.GENERATE
          ? await timed_(() => arm.provider.generate(generateTask(row)))
          : await timed_(() => arm.provider.reconcile(reconcileTask(row)));

      arm.latency.push(timed.ms);
      if (timed.ms <= opts.reconcileCapMs) arm.withinCap++;

      if (timed.value === null) {
        arm.failures++;
        continue;
      }

      if (judgedMerge(role, timed.value) === row.expectMerge) arm.correct++;
    }
  }

  const [base, cand] = arms.map((arm) => ({
    model: arm.model,
    accuracy: arm.correct / usable.length,
    failures: arm.failures,
    p50_ms: percentile(arm.latency, 0.5),
    max_ms: Math.max(...arm.latency),
    within_cap: arm.withinCap,
  }));
  const drop = base!.accuracy - cand!.accuracy;
  const floor = majorityRate(usable.map((row) => row.expectMerge));
  const measurable = base!.accuracy >= floor + GATES.floorMargin;

  return {
    sampled: usable.length,
    labels: `${String(usable.filter((r) => r.expectMerge).length)} applied / ${String(
      usable.filter((r) => !r.expectMerge).length,
    )} dismissed`,
    baseline: base,
    candidate: cand,
    accuracy_drop: drop,
    majority_rate: floor,
    measurable,
    verdict: !measurable || drop > GATES.accuracyDrop || cand!.failures > 0 ? "fail" : "pass",
    ...(measurable
      ? {}
      : {
          note:
            "the baseline does not beat a constant answer on these labels — either the task " +
            "shape or the labels cannot support this gate, and no swap can be justified by it",
        }),
  };
}

// annotate has no labels: nobody ever adjudicated a keyword set. Scored on agreement with
// the baseline, and on the one faithfulness rule that can be checked mechanically — the
// prompt forbids inventing numbers, so a digit string absent from the record is a red flag.
async function annotateRole(
  opts: { baseline: string; candidate: string; url: string },
  records: { title: string; content: string; project: string | null }[],
): Promise<Record<string, unknown> & { verdict: string }> {
  if (!records.length) {
    return { sampled: 0, verdict: "skip", note: "no semantic records in this store" };
  }

  const providers = {
    baseline: providerFor(opts.baseline, opts.url),
    candidate: providerFor(opts.candidate, opts.url),
  };
  const selfCoverage: number[] = [];
  const candCoverage: number[] = [];
  const overlaps: number[] = [];
  const baseLatency: number[] = [];
  const candLatency: number[] = [];
  let invented = 0;
  let failures = 0;
  let candidateKeywords = 0;
  let baselineKeywords = 0;

  for (const record of records) {
    const task: AnnotateTask = record;
    const first = await timed_(() => providers.baseline.annotate(task));
    const again = await timed_(() => providers.baseline.annotate(task));
    const cand = await timed_(() => providers.candidate.annotate(task));

    baseLatency.push(first.ms);
    candLatency.push(cand.ms);

    if (first.value === null || again.value === null || cand.value === null) {
      failures++;
      continue;
    }

    const reference = terms(first.value);

    baselineKeywords += first.value.keywords.length;
    candidateKeywords += cand.value.keywords.length;
    selfCoverage.push(coverage(reference, terms(again.value)));
    candCoverage.push(coverage(reference, terms(cand.value)));
    overlaps.push(jaccard(reference, terms(cand.value)));
    invented += inventedNumbers(cand.value, record);
  }

  const floor = mean(selfCoverage);
  const reached = mean(candCoverage);
  const faster = percentile(candLatency, 0.5) < percentile(baseLatency, 0.5);

  return {
    sampled: records.length,
    baseline_self_coverage: floor,
    candidate_coverage: reached,
    coverage_drop: floor - reached,
    keyword_jaccard_p50: percentile(overlaps, 0.5),
    baseline: {
      model: opts.baseline,
      p50_ms: percentile(baseLatency, 0.5),
      keywords_per_record: baselineKeywords / Math.max(1, candCoverage.length),
    },
    candidate: {
      model: opts.candidate,
      p50_ms: percentile(candLatency, 0.5),
      keywords_per_record: candidateKeywords / Math.max(1, candCoverage.length),
    },
    invented_numbers: invented,
    failures,
    faster,
    verdict:
      floor - reached <= GATES.coverageDrop && invented === 0 && failures === 0 && faster
        ? "pass"
        : "fail",
  };
}

function providerFor(model: string, url: string): HttpConsolidator {
  return new HttpConsolidator({
    roles: resolveRoles({ url, model, timeoutMs: TIMEOUT_MS, reconcileTimeoutMs: TIMEOUT_MS }),
  });
}

function generateTask(row: Labelled): ConsolidationTask {
  return {
    kind:
      row.kind === ConsolidationKind.MERGE ? ConsolidationKind.MERGE : ConsolidationKind.DISTILL,
    project: null,
    inputs: row.members,
  };
}

// The draft is one member of a cluster an agent already ruled on, judged against the rest —
// which is the shape a `write` actually sends.
function reconcileTask(row: Labelled): ReconcileTask {
  const [draft, ...rest] = row.members;

  return {
    draft: { title: draft!.title, type: "fact", content: draft!.content },
    project: null,
    candidates: rest,
  };
}

function judgedMerge(role: GenerationRole, value: ConsolidationResult | ReconcileResult): boolean {
  return role === GenerationRole.GENERATE
    ? (value as ConsolidationResult).recommendation === ConsolidationRecommendation.APPLY
    : (value as ReconcileResult).action !== ReconcileAction.NOOP;
}

async function timed_<T>(call: () => Promise<T>): Promise<Timed<T>> {
  const started = Date.now();

  try {
    const value = await call();

    return { ms: Date.now() - started, value };
  } catch (err) {
    return {
      ms: Date.now() - started,
      value: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Ordered by `member_hash`, which is a sha256 already in the table: the order is stable, so
// two runs compare the same clusters and a number that moved means the model moved — and it
// is uncorrelated with age, unlike id order, whose head is old candidates whose members have
// since been superseded. The whole labelled set is read; it is a few hundred rows.
function loadLabelled(db: Database.Database, n: number): Labelled[] {
  const rows = db
    .prepare(
      `SELECT id, kind, status, member_ids
         FROM consolidation_candidates
        WHERE status IN ('applied','dismissed') AND kind IN ('merge','distill')
        ORDER BY member_hash`,
    )
    .all() as { id: string; kind: ConsolidationKind; status: string; member_ids: string }[];
  const content = db.prepare(
    `SELECT n.id AS id, n.title AS title, r.content AS content
       FROM nodes n
       JOIN revisions r ON r.node_id = n.id
      WHERE n.id = ?
      ORDER BY r.rev DESC
      LIMIT 1`,
  );
  const balanced: Labelled[] = [];
  const half = Math.max(1, Math.floor(n / 2));
  let applied = 0;
  let dismissed = 0;

  for (const row of rows) {
    const expectMerge = row.status === "applied";

    if (expectMerge && applied >= half) continue;
    if (!expectMerge && dismissed >= n - half) continue;

    const members = (JSON.parse(row.member_ids) as string[])
      .map((id) => content.get(id) as Labelled["members"][number] | undefined)
      .filter((member): member is Labelled["members"][number] => member !== undefined);

    // A cluster whose members have since been hard-superseded cannot be re-judged.
    if (members.length < 2) continue;

    balanced.push({ id: row.id, kind: row.kind, expectMerge, members });
    if (expectMerge) applied++;
    else dismissed++;
    if (balanced.length >= n) break;
  }

  return balanced;
}

function loadRecords(
  db: Database.Database,
  n: number,
): { title: string; content: string; project: string | null }[] {
  return db
    .prepare(
      `SELECT n.title AS title, n.project AS project, r.content AS content
         FROM nodes n
         JOIN revisions r ON r.node_id = n.id
                         AND r.rev = (SELECT MAX(rev) FROM revisions WHERE node_id = n.id)
        WHERE n.memory_kind = 'semantic' AND n.invalidated_at IS NULL
        ORDER BY n.id
        LIMIT ?`,
    )
    .all(n) as { title: string; content: string; project: string | null }[];
}

function render(
  opts: {
    dbPath: string;
    baseline: string;
    candidate: string;
    url: string;
    reconcileCapMs: number;
  },
  results: Record<string, unknown>,
  passes: boolean,
): string {
  const L: string[] = [];

  L.push(`store     ${opts.dbPath}`);
  L.push(`baseline  ${opts.baseline}`);
  L.push(`candidate ${opts.candidate} at ${opts.url}`);

  for (const [role, outcome] of Object.entries(results)) {
    const row = outcome as Record<string, unknown>;

    L.push("");
    L.push(`${role}  (${String(row.verdict).toUpperCase()})`);

    if (row.verdict === "skip") {
      L.push(`  ${String(row.note)}`);
      continue;
    }

    if ((role as GenerationRole) === GenerationRole.ANNOTATE) {
      const base = row.baseline as { p50_ms: number; keywords_per_record: number };
      const cand = row.candidate as { p50_ms: number; keywords_per_record: number };

      L.push(`  records            : ${String(row.sampled)}`);
      L.push(
        `  attribute coverage : baseline reproduces ${fmt(row.baseline_self_coverage as number)} ` +
          `of its own, candidate ${fmt(row.candidate_coverage as number)} of the baseline's ` +
          `(drop ${fmt(row.coverage_drop as number)}, gate ${String(GATES.coverageDrop)})`,
      );
      L.push(
        `  jaccard p50        : ${fmt(row.keyword_jaccard_p50 as number)} (signal, not a gate)`,
      );
      L.push(
        `  attributes/record  : ${fmt(base.keywords_per_record)} -> ${fmt(cand.keywords_per_record)}`,
      );
      L.push(`  latency p50        : ${ms(base.p50_ms)} -> ${ms(cand.p50_ms)}`);
      L.push(`  invented numbers   : ${String(row.invented_numbers)} (gate 0)`);
      L.push(`  faster than baseline: ${row.faster === true ? "yes" : "no — nothing to gain"}`);
      continue;
    }

    const base = row.baseline as Record<string, number | string>;
    const cand = row.candidate as Record<string, number | string>;

    L.push(`  clusters           : ${String(row.sampled)}  (${String(row.labels)})`);
    L.push(
      `  constant answer    : ${fmt(row.majority_rate as number)}` +
        (row.measurable === true ? "" : "  <- the baseline does not beat it"),
    );
    L.push(
      `  accuracy vs labels : ${fmt(base.accuracy as number)} -> ${fmt(cand.accuracy as number)}` +
        `  (drop ${fmt(row.accuracy_drop as number)}, gate ${String(GATES.accuracyDrop)})`,
    );
    L.push(
      `  latency p50 / max  : ${ms(base.p50_ms as number)} / ${ms(base.max_ms as number)}` +
        ` -> ${ms(cand.p50_ms as number)} / ${ms(cand.max_ms as number)}`,
    );
    L.push(
      `  within ${String(opts.reconcileCapMs)}ms cap : ${String(base.within_cap)} -> ${String(
        cand.within_cap,
      )} of ${String(row.sampled)}`,
    );
    L.push(`  provider failures  : ${String(base.failures)} -> ${String(cand.failures)}`);
    if (typeof row.note === "string") L.push(`  ${row.note}`);
  }

  L.push("");
  L.push(
    passes
      ? `PASS — every role measured holds. A role may be pointed at ${opts.candidate} in consolidation.roles.`
      : `FAIL — at least one role does not hold. Leave it on ${opts.baseline}; latency is not worth a judge that answers differently.`,
  );

  return L.join("\n");
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);

  return at === -1 ? undefined : process.argv[at + 1];
}

function fmt(x: number): string {
  return x.toFixed(3);
}

function ms(x: number): string {
  return `${(x / 1000).toFixed(1)}s`;
}

await main();
