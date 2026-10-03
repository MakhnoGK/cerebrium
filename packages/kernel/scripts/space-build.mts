import "reflect-metadata";
import { container } from "tsyringe";
import { EmbeddingRole } from "@/domain/ports/embedding-provider";
import { VECTOR_SPACES_REPO_TOKEN, type VectorSpacesRepo } from "@/domain/ports/storage";
import { buildContainer } from "@/container";
import { createProvider } from "@/embeddings";
import { EnvConfigSource, LayeredConfigSource, StaticConfigSource } from "@/infrastructure/config";

// Fills a vector space for one embedding model in a Postgres store, so candidate models can
// be compared on the same chunks. Writes only the new space; the active one is untouched
// unless --activate is passed.

const HELP = `
space-build — embed every live chunk of a Postgres store into the space of one model.

  npm run space:build -- --pg URL --model MODEL [--batch N] [--activate]

  --pg URL      The store. Writes to it: run it against a copy, not the host.
  --model M     A model with an embedding profile (see src/embeddings/profiles.ts).
  --batch N     Chunks per embedding call (default 1). Above 1, a probe refuses a model whose
                vectors move with their batch-mates (q8 quantization, padding).
  --activate    Make the space the active one once every live chunk has a vector.
`;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);

  return i < 0 ? undefined : argv[i + 1];
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;

  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;

  return dot;
}

async function main() {
  const argv = process.argv.slice(2);
  const url = arg(argv, "--pg");
  const model = arg(argv, "--model");

  if (argv.includes("--help") || !url || !model) {
    console.log(HELP);
    return;
  }

  const batch = Number(arg(argv, "--batch") ?? 1);
  const scope = buildContainer({
    role: "server",
    source: new LayeredConfigSource(
      new StaticConfigSource({ MEMORY_STORE_BACKEND: "postgres", MEMORY_PG_URL: url }),
      new EnvConfigSource(),
    ),
    into: container.createChildContainer(),
  });
  const spaces = scope.resolve<VectorSpacesRepo>(VECTOR_SPACES_REPO_TOKEN);
  const provider = createProvider("local", model);
  const space = await spaces.ensureSpace(model, provider.dim, new Date().toISOString());

  console.log(`space ${String(space.id)}: ${model} (${String(provider.dim)}-d)`);

  // q8 activation scales are computed over the whole batch, and last-token pooling reads
  // padding, so a batched vector can differ from the same text embedded alone.
  const probe = batch > 1 ? await spaces.unembeddedChunks(space.id, 4) : [];

  if (probe.length > 1) {
    const together = await provider.embed(
      probe.map((c) => c.text),
      EmbeddingRole.PASSAGE,
    );

    for (const [i, chunk] of probe.entries()) {
      const [alone] = await provider.embed([chunk.text], EmbeddingRole.PASSAGE);
      const agreement = cosine(together[i]!, alone!);

      if (agreement < 0.999) {
        throw new Error(
          `batched and single embeddings disagree (${agreement.toFixed(4)}); embed with --batch 1`,
        );
      }
    }
  }

  const started = Date.now();
  let done = 0;

  for (;;) {
    const chunks = await spaces.unembeddedChunks(space.id, batch);

    if (!chunks.length) break;

    const vectors = await provider.embed(
      chunks.map((c) => c.text),
      EmbeddingRole.PASSAGE,
    );

    await spaces.putChunkVectors(
      space.id,
      chunks.map((c, i) => ({ chunkId: c.id, vector: vectors[i]! })),
      provider.version,
      new Date().toISOString(),
    );
    done += chunks.length;

    if (done % 500 < batch) {
      console.log(`  ${String(done)} chunks, ${((Date.now() - started) / 1000).toFixed(0)} s`);
    }
  }

  const coverage = await spaces.coverage(space.id);
  const seconds = (Date.now() - started) / 1000;

  console.log(
    `embedded ${String(done)} chunks in ${seconds.toFixed(0)} s; coverage ${String(coverage.embedded)}/${String(coverage.chunks)}`,
  );

  if (!argv.includes("--activate")) return;

  if (coverage.embedded !== coverage.chunks) {
    throw new Error("refusing to activate a space that does not cover every live chunk");
  }

  await spaces.activate(space.id);
  console.log(`space ${String(space.id)} is now active`);
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error("space-build failed:", e);
    process.exit(1);
  },
);
