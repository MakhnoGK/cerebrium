import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { CodeParser, ParseOutcome } from "@/domain/ports/code-parser";

export interface CodeWorkerRequest {
  id: number;
  units: { path: string; content: string }[];
}

export type CodeWorkerResponse =
  { id: number; ok: true; outcomes: ParseOutcome[] } | { id: number; ok: false; error: string };

// Only the built bundle can be a worker entry; from source the caller parses in-process.
export function resolveCodeWorker(): string | null {
  for (const rel of ["./code-worker.js", "../code-worker.js"]) {
    const candidate = fileURLToPath(new URL(rel, import.meta.url));

    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

interface Pending {
  resolve: (outcomes: ParseOutcome[]) => void;
  reject: (error: Error) => void;
}

// One parse thread, respawned after a crash. Requests queue on it in order.
export class WorkerCodeParser implements CodeParser {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly entry: string) {}

  parse(units: { path: string; content: string }[]): Promise<ParseOutcome[]> {
    const worker = this.spawn();
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, units } satisfies CodeWorkerRequest);
    });
  }

  async close(): Promise<void> {
    const worker = this.worker;

    this.worker = null;
    this.fail(new Error("the code parser was closed"));

    await worker?.terminate();
  }

  private spawn(): Worker {
    if (this.worker) return this.worker;

    const worker = new Worker(this.entry);

    worker.unref();
    worker.on("message", (message: CodeWorkerResponse) => {
      const waiting = this.pending.get(message.id);

      if (!waiting) return;

      this.pending.delete(message.id);

      if (message.ok) waiting.resolve(message.outcomes);
      else waiting.reject(new Error(message.error));
    });
    worker.on("error", (err: Error) => {
      this.retire(worker, err);
    });
    worker.on("exit", (code) => {
      this.retire(worker, new Error(`code worker exited with code ${String(code)}`));
    });

    this.worker = worker;

    return worker;
  }

  private retire(worker: Worker, err: Error): void {
    if (this.worker !== worker) return;

    this.worker = null;
    this.fail(err);
  }

  private fail(err: Error): void {
    for (const waiting of this.pending.values()) waiting.reject(err);

    this.pending.clear();
  }
}
