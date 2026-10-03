import "reflect-metadata";
import { container } from "tsyringe";
import { PG_TOKEN, type PgDatabase } from "@/db/postgres/database";
import { buildContainer } from "@/container";
import { EnvConfigSource, LayeredConfigSource, StaticConfigSource } from "@/infrastructure/config";

// How well one vector space tells related notes from unrelated ones. Related pairs are the
// links agents wrote themselves; unrelated pairs are random. Each note is its first chunk.

const HELP = `
space-report — separation of related from random notes in each vector space of a store.

  npm run space:report -- --pg URL [--pairs N]

  --pg URL   The store (opened read-only).
  --pairs N  Random note pairs to sample (default 5000; the same pairs for every space).

Columns: random-pair cosine (mean, p90), agent-linked-pair cosine (mean), and AUC — the
chance a linked pair scores above a random one (0.5 = cosine cannot tell them apart).
`;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);

  return i < 0 ? undefined : argv[i + 1];
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }

  return dot / Math.sqrt(na * nb);
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

// Mann-Whitney: the share of (linked, random) pairs where the linked one scores higher.
function auc(positive: number[], negative: number[]): number {
  const all = [
    ...positive.map((v) => ({ v, p: true })),
    ...negative.map((v) => ({ v, p: false })),
  ].sort((x, y) => x.v - y.v);
  let rankSum = 0;

  for (const [i, item] of all.entries()) if (item.p) rankSum += i + 1;

  const n = positive.length;

  return (rankSum - (n * (n + 1)) / 2) / (n * negative.length);
}

function randomPairs(ids: string[], count: number): [string, string][] {
  let state = 2463534242;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;

    return state / 0x100000000;
  };
  const out: [string, string][] = [];

  while (out.length < count) {
    const a = ids[Math.floor(next() * ids.length)]!;
    const b = ids[Math.floor(next() * ids.length)]!;

    if (a !== b) out.push([a, b]);
  }

  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const url = arg(argv, "--pg");

  if (argv.includes("--help") || !url) {
    console.log(HELP);
    return;
  }

  const scope = buildContainer({
    role: "cli",
    source: new LayeredConfigSource(
      new StaticConfigSource({ MEMORY_STORE_BACKEND: "postgres", MEMORY_PG_URL: url }),
      new EnvConfigSource(),
    ),
    into: container.createChildContainer(),
  });
  const pg = scope.resolve<PgDatabase>(PG_TOKEN);
  const spaces = (
    await pg.query<{ id: number; model: string; dim: number; active: boolean }>(
      "SELECT id, model, dim, active FROM vector_spaces ORDER BY id",
    )
  ).rows;
  const linked = (
    await pg.query<{ src: string; dst: string }>(
      `SELECT e.src, e.dst FROM edges e
       JOIN nodes a ON a.id = e.src JOIN nodes b ON b.id = e.dst
       WHERE e.invalidated_at IS NULL AND e.provenance = 'agent' AND e.src <> e.dst
         AND a.invalidated_at IS NULL AND b.invalidated_at IS NULL
         AND a.memory_kind IN ('semantic', 'episodic') AND b.memory_kind IN ('semantic', 'episodic')`,
    )
  ).rows;
  const pairCount = Number(arg(argv, "--pairs") ?? 5000);

  console.log(`agent-linked pairs: ${String(linked.length)}, random pairs: ${String(pairCount)}\n`);
  console.log(
    "space | model                                    |  dim | random mean | random p90 | linked mean |   AUC",
  );
  console.log(
    "------+------------------------------------------+------+-------------+------------+-------------+------",
  );

  let shared: [string, string][] | null = null;

  for (const space of spaces) {
    const rows = (
      await pg.query<{ id: string; embedding: string }>(
        `SELECT DISTINCT ON (c.node_id) c.node_id AS id, v.embedding::text AS embedding
         FROM chunks c
         JOIN nodes n ON n.id = c.node_id
         JOIN chunk_vectors v ON v.chunk_id = c.id AND v.space_id = @space
         WHERE c.stale = 0 AND n.invalidated_at IS NULL
           AND n.memory_kind IN ('semantic', 'episodic')
         ORDER BY c.node_id, c.seq`,
        { space: space.id },
      )
    ).rows;
    const vectors = new Map(
      rows.map((r) => [r.id, Float32Array.from(JSON.parse(r.embedding) as number[])]),
    );

    shared ??= randomPairs([...vectors.keys()].sort(), pairCount);

    const score = (pairs: [string, string][]) =>
      pairs
        .filter(([a, b]) => vectors.has(a) && vectors.has(b))
        .map(([a, b]) => cosine(vectors.get(a)!, vectors.get(b)!));
    const random = score(shared).sort((x, y) => x - y);
    const related = score(linked.map((l) => [l.src, l.dst] as [string, string]));

    console.log(
      `${String(space.id).padStart(5)} | ${space.model.padEnd(40)} | ${String(space.dim).padStart(4)} | ` +
        `${mean(random).toFixed(3).padStart(11)} | ${quantile(random, 0.9).toFixed(3).padStart(10)} | ` +
        `${mean(related).toFixed(3).padStart(11)} | ${auc(related, random).toFixed(3)}${space.active ? "  (active)" : ""}`,
    );
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error("space-report failed:", e);
    process.exit(1);
  },
);
