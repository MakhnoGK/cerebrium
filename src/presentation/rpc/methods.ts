import type { DependencyContainer } from "tsyringe";
import { OPERATOR_SNAPSHOT, type OperatorSnapshot, type ReadName } from "@/application/use-cases";
import { PROTOCOL_VERSION } from "@/core/rpc";
import type { RpcMethod } from "@/presentation/rpc/server";

// Dispatches a named read somewhere other than this thread. Absent when there is no read
// pool, in which case the handler falls back to resolving in-process.
export type ReadDispatch = (name: ReadName, args: unknown) => Promise<unknown>;

export interface DaemonIdentity {
  pid: number;
  // Reads waiting for a worker. Part of `status` because a client that is being made to
  // wait should be able to see why.
  queueDepth?: () => number;
  // Reported rather than awaited: `status` has to answer while the model is still
  // loading, and after a load that failed outright.
  model: () => { state: string; ms: number | null; error?: string } | null;
}

export function createDaemonMethods(
  container: DependencyContainer,
  identity: DaemonIdentity,
  reads?: ReadDispatch,
): Record<string, RpcMethod> {
  return {
    // The version handshake. A client calls this before anything else and refuses a
    // protocol it does not speak, so a rebuild against a still-running resident daemon
    // reports the mismatch instead of failing later as an unknown method.
    initialize: () => Promise.resolve({ protocol: PROTOCOL_VERSION, pid: identity.pid }),

    // The operator payload, not the compact one the agent-facing `stats` tool returns:
    // this is the surface the CLI and the GUI render.
    //
    // Answered off the main thread when a pool exists. This call is ~140ms of synchronous
    // SQLite work, and running it here is what used to make every other client wait for
    // its full remainder.
    status: async () => {
      const snapshot =
        reads === undefined
          ? await container.resolve<OperatorSnapshot>(OPERATOR_SNAPSHOT).invoke({})
          : await reads("operator_snapshot", {});

      return {
        ...(snapshot as object),
        daemon: {
          ...identity.model(),
          pid: identity.pid,
          ...(identity.queueDepth === undefined ? {} : { queue_depth: identity.queueDepth() }),
        },
      };
    },
  };
}
