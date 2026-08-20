import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { cerebriumHome } from "@/runtime/paths";
import type { PoolRequest, PoolResponse, PoolWorker } from "@/runtime/read-pool";

// Only the built bundle can be a worker entry: `new Worker` hands the file to plain Node,
// which cannot execute TypeScript. Running from source there is nothing to spawn, and the
// caller serves reads in-process instead.
export function resolveReadWorker(): string | null {
  for (const rel of ["./read-worker.js", "../read-worker.js"]) {
    const candidate = fileURLToPath(new URL(rel, import.meta.url));

    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

class NodePoolWorker implements PoolWorker {
  private readonly worker: Worker;

  constructor(entry: string, dbPath: string) {
    this.worker = new Worker(entry, {
      // The worker resolves its own configuration, so it must land on the same install
      // root and the same database as the process that spawned it.
      env: { ...process.env, CEREBRIUM_HOME: cerebriumHome(), MEMORY_DB_PATH: dbPath },
    });
    this.worker.unref();
  }

  post(message: PoolRequest): void {
    this.worker.postMessage(message);
  }

  onMessage(handler: (message: PoolResponse) => void): void {
    this.worker.on("message", handler);
  }

  onError(handler: (error: Error) => void): void {
    this.worker.on("error", handler);
    this.worker.on("exit", (code) => {
      if (code !== 0) handler(new Error(`read worker exited with code ${String(code)}`));
    });
  }

  async terminate(): Promise<void> {
    await this.worker.terminate();
  }
}

export function nodeWorkerFactory(entry: string, dbPath: string): () => PoolWorker {
  return () => new NodePoolWorker(entry, dbPath);
}
