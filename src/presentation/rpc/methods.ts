import type { DependencyContainer } from "tsyringe";
import {
  CALL_SURFACE,
  OPERATOR_SNAPSHOT,
  type CallName,
  type OperatorSnapshot,
  type ReadName,
} from "@/application/use-cases";
import { UNKNOWN_WRITER, type Writer } from "@/runtime/client-identity";
import { PROTOCOL_VERSION, type RpcMeta } from "@/core/rpc";
import { validateCall } from "@/presentation/rpc/schemas";
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

// One JSON-RPC method per call on the surface, dispatched through the pipeline so a socket
// caller gets the same session check and the same audit row as an MCP caller.
export function surfaceMethods(
  call: (name: CallName, args: Record<string, unknown>, writer: Writer) => Promise<unknown>,
): Record<string, RpcMethod> {
  return Object.fromEntries(
    (Object.keys(CALL_SURFACE) as CallName[]).map((name) => [
      name,
      // Validated at the edge, before the pipeline touches the writer. The identity comes
      // from `meta` and never from `params`, which the schema has already stripped.
      (params: Record<string, unknown>, meta: RpcMeta) =>
        call(name, validateCall(name, params), writerOf(meta)),
    ]),
  );
}

function writerOf(meta: RpcMeta): Writer {
  return meta.client == null && meta.version == null
    ? UNKNOWN_WRITER
    : { client: meta.client ?? null, version: meta.version ?? null };
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
