import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  EmbeddingRole,
  VECTOR_DIM,
  type EmbeddingProvider,
} from "@/domain/ports/embedding-provider";

// An embedding provider whose model lives in a worker thread. The port is already async, so
// this substitutes for the in-process provider without anything else changing.
//
// Why it exists: loading the model blocks its thread for over a second, and when that thread
// is also the one answering the socket, every call during startup times out. Keeping the
// model here means the daemon's main thread stays responsive while it loads.

interface Pending {
  resolve: (vectors: number[][]) => void;
  reject: (error: Error) => void;
}

type WorkerReply =
  | { ready: true; name: string; version: string; dim: number }
  | { id: number; ok: true; vectors: number[][] }
  | { id: number; ok: false; error: string };

export function resolveEmbedWorker(): string | null {
  for (const rel of ["./embed-worker.js", "../embed-worker.js"]) {
    const candidate = fileURLToPath(new URL(rel, import.meta.url));

    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export class WorkerEmbeddingProvider implements EmbeddingProvider {
  readonly name = "worker";
  readonly version = "1";
  readonly dim = VECTOR_DIM;

  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private next = 1;
  private dead: Error | null = null;

  constructor(entry: string, env: NodeJS.ProcessEnv = process.env) {
    this.worker = new Worker(entry, { env: { ...env } });
    this.worker.unref();

    this.worker.on("message", (reply: WorkerReply) => {
      if ("ready" in reply) return;

      const waiting = this.pending.get(reply.id);

      if (!waiting) return;

      this.pending.delete(reply.id);

      if (reply.ok) {
        waiting.resolve(reply.vectors);
      } else {
        waiting.reject(new Error(reply.error));
      }
    });

    // A dead model worker must fail loudly and keep failing, rather than leaving callers
    // waiting on a thread that will never answer.
    this.worker.on("error", (err: unknown) => {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    });
    this.worker.on("exit", (code) => {
      if (code !== 0) this.fail(new Error(`embed worker exited with code ${String(code)}`));
    });
  }

  embed(texts: string[], role: EmbeddingRole = EmbeddingRole.PASSAGE): Promise<number[][]> {
    return this.send({ op: "embed", texts, role });
  }

  async warm(): Promise<void> {
    await this.send({ op: "warm" });
  }

  async close(): Promise<void> {
    await this.worker.terminate();
  }

  private send(request: { op: "warm" } | { op: "embed"; texts: string[]; role: EmbeddingRole }) {
    if (this.dead) return Promise.reject(this.dead);

    const id = this.next++;

    return new Promise<number[][]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...request });
    });
  }

  private fail(error: Error): void {
    this.dead = error;

    for (const [id, waiting] of this.pending) {
      this.pending.delete(id);
      waiting.reject(error);
    }
  }
}

// What a read-pool worker gets. The invariant that read workers hold no model was a comment
// before, and a hybrid search arriving without a precomputed vector quietly loaded one in
// every worker — measured at +224MB for a single search. Now it fails instead of costing
// that silently: whoever dispatched the read was supposed to supply the vector.
export class NoEmbeddingProvider implements EmbeddingProvider {
  readonly name = "no-embedding";
  readonly version = "1";
  readonly dim = VECTOR_DIM;

  embed(): Promise<number[][]> {
    return Promise.reject(
      new Error(
        "this process holds no embedding model — pass query_vector with the call, or the " +
          "dispatcher should have supplied it",
      ),
    );
  }
}
