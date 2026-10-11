#!/usr/bin/env node
import "reflect-metadata";
import { EmbeddingRole } from "@/domain/ports/embedding-provider";
import { PG_TOKEN, redactUrl, type PgDatabase } from "@/db/postgres/database";
import { HttpProvider } from "@/embeddings/http";
import { buildContainer } from "@/container";
import {
  EmbeddingConfig,
  EnvConfigSource,
  LayeredConfigSource,
  StaticConfigSource,
} from "@/infrastructure/config";

// The gate in front of switching the embedding provider: `npm run eval:embedding`. Answers
// the only question that matters — would vectors from the HTTP model land in the same space
// as the ones already in the store — by comparing a fresh remote embedding against the
// STORED vector (active space) for the same chunk text. Read-only, `cli` role, never a
// second writer.
//
// Cosine is what search compares, so cosine is what this reports. A dimension mismatch
// throws inside the provider; this is for the case where the dimensions agree and the
// model does not, which no runtime check can see.
const GATE = 0.99;
const SAMPLE = 64;

interface Sample {
  id: string;
  text: string;
  stored: number[];
}

const USAGE =
  "usage: npm run eval:embedding -- --pg URL [--n 64] [--model TAG] [--url URL] [--json]\n";

function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(USAGE);

    return Promise.resolve();
  }

  const store = flag("--pg");

  if (!store) {
    process.stderr.write(USAGE);
    process.exitCode = 1;

    return Promise.resolve();
  }

  const container = buildContainer({
    role: "cli",
    source: new LayeredConfigSource(
      new StaticConfigSource({ MEMORY_PG_URL: store }),
      new EnvConfigSource(),
    ),
  });
  const db = container.resolve<PgDatabase>(PG_TOKEN);
  const config = container.resolve(EmbeddingConfig);

  return report({
    db,
    dbPath: redactUrl(store),
    n: Number(flag("--n") ?? SAMPLE),
    model: flag("--model") ?? config.model,
    url: flag("--url") ?? config.url,
    timeoutMs: config.timeoutMs,
    batchSize: config.batchSize,
    asJson: process.argv.includes("--json"),
  });
}

async function report(opts: {
  db: PgDatabase;
  dbPath: string;
  n: number;
  model: string;
  url: string;
  timeoutMs: number;
  batchSize: number;
  asJson: boolean;
}): Promise<void> {
  const samples = await loadSamples(opts.db, opts.n);

  if (!samples.length) {
    process.stdout.write("no embedded chunks in this store — nothing to compare\n");

    return;
  }

  const provider = new HttpProvider({
    model: opts.model,
    url: opts.url,
    timeoutMs: opts.timeoutMs,
    batchSize: opts.batchSize,
  });

  // Passage role: it is what wrote every vector in `chunk_vectors`, and the prefix is part of
  // what is being compared.
  const fresh = await provider.embed(
    samples.map((s) => s.text),
    EmbeddingRole.PASSAGE,
  );
  const scores = samples.map((s, i) => cosine(s.stored, fresh[i] ?? []));
  const below = scores.filter((x) => x < GATE).length;
  const passes = below === 0;

  if (opts.asJson) {
    process.stdout.write(
      `${JSON.stringify({
        db: opts.dbPath,
        model: opts.model,
        url: opts.url,
        sampled: scores.length,
        gate: GATE,
        min: Math.min(...scores),
        mean: mean(scores),
        p10: percentile(scores, 0.1),
        p50: percentile(scores, 0.5),
        below_gate: below,
        verdict: passes ? "pass" : "fail",
      })}\n`,
    );
  } else {
    const L: string[] = [];

    L.push(`store   ${opts.dbPath}`);
    L.push(`remote  ${opts.model} at ${opts.url}`);
    L.push(`wrote the stored vectors: ${await storedModels(opts.db)}`);
    L.push("");
    L.push(`cosine against the stored vector, ${String(scores.length)} chunks`);
    L.push(`  min   ${fmt(Math.min(...scores))}`);
    L.push(`  p10   ${fmt(percentile(scores, 0.1))}`);
    L.push(`  p50   ${fmt(percentile(scores, 0.5))}`);
    L.push(`  mean  ${fmt(mean(scores))}`);
    L.push(`  below ${String(GATE)}: ${String(below)} of ${String(scores.length)}`);
    L.push("");
    L.push(
      passes
        ? `PASS — every sampled chunk agrees to >= ${String(GATE)}. Run \`npm run eval:retrieval\` before switching; both gates have to hold.`
        : `FAIL — ${String(below)} chunk(s) below ${String(GATE)}. This model does not share the store's vector space: switching to it needs a full re-embed, not a config change.`,
    );

    process.stdout.write(`${L.join("\n")}\n`);
  }

  if (!passes) process.exitCode = 1;
}

async function loadSamples(db: PgDatabase, n: number): Promise<Sample[]> {
  // Ordered by id, not random: two runs of this script compare the same chunks, so a
  // number that moved means the model moved.
  const { rows } = await db.query<{ id: string; text: string; embedding: string }>(
    `SELECT c.id AS id, c.text AS text, v.embedding::text AS embedding
       FROM chunks c
       JOIN chunk_vectors v ON v.chunk_id = c.id
       JOIN vector_spaces s ON s.id = v.space_id AND s.active
      WHERE c.stale = 0
      ORDER BY c.id
      LIMIT @n`,
    { n },
  );

  return rows.map((row) => ({
    id: row.id,
    text: row.text,
    stored: JSON.parse(row.embedding) as number[],
  }));
}

async function storedModels(db: PgDatabase): Promise<string> {
  const { rows } = await db.query<{ model: string; version: string; c: string }>(
    `SELECT s.model, v.model_version AS version, COUNT(*) AS c
       FROM chunk_vectors v JOIN vector_spaces s ON s.id = v.space_id AND s.active
      GROUP BY s.model, v.model_version ORDER BY c DESC`,
  );

  return rows.length
    ? rows.map((r) => `${r.model}@${r.version} x${r.c}`).join(", ")
    : "nothing recorded";
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;

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

  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);

  return at === -1 ? undefined : process.argv[at + 1];
}

function mean(values: number[]): number {
  return values.length ? values.reduce((t, x) => t + x, 0) / values.length : 0;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;

  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

function fmt(x: number): string {
  return x.toFixed(4);
}

await main();
process.exit();
