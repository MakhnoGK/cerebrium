import type { DependencyContainer } from "tsyringe";
import {
  CALL_SURFACE,
  CLAIM_JOB,
  ENQUEUE_AGENT_JOB,
  FINISH_JOB,
  OPERATOR_SNAPSHOT,
  RENEW_JOB,
  type AgentRunReport,
  type CallName,
  type ClaimJob,
  type EnqueueAgentJob,
  type FinishJob,
  type OperatorSnapshot,
  type ReadName,
  type RenewJob,
} from "@/application/use-cases";
import { UNKNOWN_WRITER, type Writer } from "@/runtime/client-identity";
import { PROTOCOL_VERSION, type RpcMeta } from "@/core/rpc";
import type { PrincipalUsage } from "@/core/types";
import { validateCall } from "@/presentation/rpc/schemas";
import type { RpcMethod } from "@/presentation/rpc/server";

// Dispatches a named read somewhere other than this thread. Absent when there is no read
// pool, in which case the handler falls back to resolving in-process.
export type ReadDispatch = (name: ReadName, args: unknown) => Promise<unknown>;

export interface DaemonIdentity {
  pid: number;
  // What each principal has spent in the current quota window. In-memory state the
  // snapshot use case cannot see, so it is reported from here alongside the queue depth.
  principals?: () => PrincipalUsage[];
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

// The runner speaks this over a socket, so its arguments are untrusted shapes rather than
// typed calls. Anything that is not the expected primitive becomes empty, and the service's
// own checks (lease ownership, the agent-only prefix) do the refusing.
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
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

    // The runner host's side of the queue. These are daemon methods rather than calls on
    // the surface deliberately: claiming and reporting a job is operational, and putting it
    // on the surface would hand the queue's internals to every principal. The trust
    // boundary is the socket's filesystem permissions, the same one `status` relies on.
    job_enqueue: (params: Record<string, unknown>) =>
      container.resolve<EnqueueAgentJob>(ENQUEUE_AGENT_JOB).invoke({
        kind: str(params.kind),
        payload:
          typeof params.payload === "object" && params.payload !== null
            ? (params.payload as Record<string, unknown>)
            : {},
        ...(positive(params.every_ms) === null ? {} : { every_ms: positive(params.every_ms)! }),
      }),

    job_claim: (params: Record<string, unknown>) =>
      container
        .resolve<ClaimJob>(CLAIM_JOB)
        .invoke({ kinds: strings(params.kinds), owner: str(params.owner) }),

    job_renew: (params: Record<string, unknown>) =>
      container
        .resolve<RenewJob>(RENEW_JOB)
        .invoke({ id: str(params.id), owner: str(params.owner) }),

    job_finish: (params: Record<string, unknown>) =>
      container.resolve<FinishJob>(FINISH_JOB).invoke({
        id: str(params.id),
        owner: str(params.owner),
        report: params.report as AgentRunReport,
      }),

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
        ...(identity.principals === undefined ? {} : { principals: identity.principals() }),
      };
    },
  };
}
