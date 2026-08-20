import "reflect-metadata";
import { parentPort } from "node:worker_threads";
import type { DependencyContainer } from "tsyringe";
import { isReadName, READ_SURFACE, type UseCase } from "@/application/use-cases";
import { buildContainer } from "@/container";

// One worker of the read pool. It holds its own read-only connection to the same database
// file, so several of these run genuinely concurrently — WAL allows any number of readers,
// and better-sqlite3 is synchronous only per connection.
//
// No embedding model lives here. A query vector arrives in the arguments, because embedding
// is ~3ms of a ~200ms search and a model per worker would cost ~150MB each.

export interface WorkerRequest {
  id: number;
  name: string;
  args: unknown;
}

export function createHandler(
  container: DependencyContainer = buildContainer({ role: "reader" }),
): (request: WorkerRequest) => Promise<unknown> {
  return async (request) => {
    if (!isReadName(request.name)) {
      throw new Error(`not a read use case: ${request.name}`);
    }

    const useCase = container.resolve<UseCase<unknown, unknown>>(READ_SURFACE[request.name]);

    return await useCase.invoke(request.args);
  };
}

function main(port: NonNullable<typeof parentPort>): void {
  // Built once, so the database handle and every prepared statement are reused across
  // calls rather than reopened per request.
  const handle = createHandler();

  port.on("message", (request: WorkerRequest) => {
    handle(request)
      .then((result) => {
        port.postMessage({ id: request.id, ok: true, result });
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
