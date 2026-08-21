import "reflect-metadata";
import { parentPort, workerData } from "node:worker_threads";
import { EmbeddingRole } from "@/domain/ports/embedding-provider";
import type { EmbedWorkerSettings } from "@/embeddings/worker-provider";
import { createProvider } from "@/embeddings";

// The one place the embedding model lives. Loading it blocks whatever thread it happens on
// for 1.2s warm and over 3s cold, so it happens here rather than on the thread that answers
// the socket — otherwise every call, including `status`, times out while the daemon starts.
//
// Inference itself barely blocks (a batch of 64 stalls ~15ms, because onnxruntime-node runs
// the graph on its own pool), so this worker is about the load, not the inference.

export type EmbedRequest =
  { id: number; op: "warm" } | { id: number; op: "embed"; texts: string[]; role: EmbeddingRole };

function main(port: NonNullable<typeof parentPort>): void {
  // Settings come from whoever spawned this thread, which is the process that resolved the
  // config tiers. The env fallback is for a spawner that passed none.
  const settings = workerData as EmbedWorkerSettings | null;
  const provider =
    settings === null
      ? createProvider(
          process.env.MEMORY_EMBED_PROVIDER ?? "local",
          process.env.MEMORY_EMBED_MODEL,
          process.env.MEMORY_MODEL_CACHE,
        )
      : createProvider(settings.provider, settings.model, settings.cacheDir, {
          url: settings.url,
          timeoutMs: settings.timeoutMs,
          batchSize: settings.batchSize,
        });

  port.postMessage({
    ready: true,
    name: provider.name,
    version: provider.version,
    dim: provider.dim,
  });

  port.on("message", (request: EmbedRequest) => {
    const work =
      request.op === "warm"
        ? Promise.resolve(provider.warm?.()).then(() => [])
        : provider.embed(request.texts, request.role);

    work
      .then((vectors) => {
        port.postMessage({ id: request.id, ok: true, vectors });
      })
      .catch((err: unknown) => {
        port.postMessage({
          id: request.id,
          ok: false,
          error: (err as Error).message || String(err),
        });
      });
  });
}

if (parentPort !== null) {
  main(parentPort);
}
