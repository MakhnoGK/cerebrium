import { parentPort } from "node:worker_threads";
import { parseUnits } from "@cerebrium/kernel/code/unit-parser";
import type {
  CodeWorkerRequest,
  CodeWorkerResponse,
} from "@cerebrium/kernel/runtime/code-worker-pool";

function main(port: NonNullable<typeof parentPort>): void {
  port.on("message", (request: CodeWorkerRequest) => {
    parseUnits(request.units)
      .then((outcomes) => {
        port.postMessage({ id: request.id, ok: true, outcomes } satisfies CodeWorkerResponse);
      })
      .catch((err: unknown) => {
        port.postMessage({
          id: request.id,
          ok: false,
          error: (err as Error).message || String(err),
        } satisfies CodeWorkerResponse);
      });
  });
}

if (parentPort !== null) {
  main(parentPort);
}
