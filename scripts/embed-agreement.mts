#!/usr/bin/env node
import "reflect-metadata";
import type Database from "better-sqlite3";
import { EmbeddingRole } from "@/domain/ports/embedding-provider";
import { DB_TOKEN } from "@/db/repositories/base";
import { HttpProvider } from "@/embeddings/http";
import { buildContainer } from "@/container";
import { DatabaseConfig, EmbeddingConfig } from "@/infrastructure/config";

// The gate in front of switching the embedding provider: `npm run eval:embedding`. Answers
// the only question that matters — would vectors from the HTTP model land in the same space
// as the ones already in the store — by comparing a fresh remote embedding against the
// STORED vector for the same chunk text. Read-only, `cli` role, never a second writer.
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

function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "usage: npm run eval:embedding -- [--n 64] [--model TAG] [--url URL] [--json]\n",
    );

    return Promise.resolve();
  }

  const container = buildContainer({ role: "cli" });
  const db = container.resolve<Database.Database>(DB_TOKEN);
  const config = container.resolve(EmbeddingConfig);

  return report({
    db,
    dbPath: container.resolve(DatabaseConfig).path,
    n: Number(flag("--n") ?? SAMPLE),
    model: flag("--model") ?? config.model,
    url: flag("--url") ?? config.url,
    timeoutMs: config.timeoutMs,
    batchSize: config.batchSize,
    asJson: process.argv.includes("--json"),
  });
}

async function report(opts: {
  db: Database.Database;
  dbPath: string;
  n: number;
  model: string;
  url: string;
  timeoutMs: number;
  batchSize: number;
  asJson: boolean;
}): Promise<void> {
  const samples = loadSamples(opts.db, opts.n);

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

  // Passage role: it is what wrote every vector in `chunk_vec`, and the prefix is part of
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
    L.push(`wrote the stored vectors: ${storedModels(opts.db)}`);
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

function loadSamples(db: Database.Database, n: number): Sample[] {
  // Ordered by id, not random: two runs of this script compare the same chunks, so a
  // number that moved means the model moved.
  const rows = db
    .prepare(
      `SELECT c.id AS id, c.text AS text, vec_to_json(v.embedding) AS embedding
         FROM chunks c
         JOIN chunk_vec v ON v.chunk_id = c.id
        WHERE c.stale = 0
        ORDER BY c.id
        LIMIT ?`,
    )
    .all(n) as { id: string; text: string; embedding: string }[];

  return rows.map((row) => ({
    id: row.id,
    text: row.text,
    stored: JSON.parse(row.embedding) as number[],
  }));
}

function storedModels(db: Database.Database): string {
  const rows = db
    .prepare(
      `SELECT model, model_version AS version, COUNT(*) AS c
         FROM embedding_meta GROUP BY model, model_version ORDER BY c DESC`,
    )
    .all() as { model: string; version: string; c: number }[];

  return rows.length
    ? rows.map((r) => `${r.model}@${r.version} x${String(r.c)}`).join(", ")
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
