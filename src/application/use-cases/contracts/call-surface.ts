import { APPLY_CANDIDATE, RETRY_CANDIDATE } from "@/application/use-cases/contracts/consolidation";
import { SUBMIT_JOB } from "@/application/use-cases/contracts/jobs";
import {
  INVALIDATE_MEMORY,
  LINK_NODES,
  RECORD_CHECKPOINT,
  RESTORE_MEMORY,
  UPDATE_MEMORY,
  WRITE_MEMORY,
} from "@/application/use-cases/contracts/memory";
import { REGISTER_SOURCE, UPSERT_MIRRORS } from "@/application/use-cases/contracts/mirror";
import { INDEX_CODE } from "@/application/use-cases/contracts/operations";
import { READ_SURFACE, type ReadName } from "@/application/use-cases/contracts/read-surface";
import { RESOLVE_REVIEW } from "@/application/use-cases/contracts/reviews";
import { SESSION_HINTS, START_SESSION } from "@/application/use-cases/contracts/session";
import { SUBSCRIBE_EVENTS } from "@/application/use-cases/contracts/subscriptions";
import { RPC_DEADLINE_MS, RpcWork } from "@/core/rpc";
import { Capability, EventAction } from "@/core/vocab";

// Everything a client outside this process may call, by name. Extends the read surface with
// the writes, so there is exactly one list to consult rather than one per delivery layer.
//
// `TOUCH_SESSION` and `RECORD_EVENTS` are deliberately absent: they are what the pipeline
// does *around* a call, not things a client asks for. `session_hints` IS here — correcting
// an earlier lumping of the three together — because tools call it themselves and a remote
// host has to be able to. It carries `audit: false`: it accompanies another call rather
// than being one, so a row of its own would double-count every tool invocation in the
// read-loop data.
export const CALL_SURFACE = {
  // Reads — safe to retry, dispatched to the read pool.
  search_memory: {
    token: READ_SURFACE.search_memory,
    kind: "read",
    action: EventAction.SEARCH,
    capability: Capability.READ,
  },
  fetch_nodes: {
    token: READ_SURFACE.fetch_nodes,
    kind: "read",
    action: EventAction.GET,
    capability: Capability.READ,
  },
  lookup_code: {
    token: READ_SURFACE.lookup_code,
    kind: "read",
    action: EventAction.CODE_LOOKUP,
    capability: Capability.READ,
  },
  stats_snapshot: {
    token: READ_SURFACE.stats_snapshot,
    kind: "read",
    action: EventAction.STATS,
    capability: Capability.READ,
  },
  operator_snapshot: {
    token: READ_SURFACE.operator_snapshot,
    kind: "read",
    action: EventAction.STATS,
    capability: Capability.READ,
  },
  suggest_candidates: {
    token: READ_SURFACE.suggest_candidates,
    kind: "read",
    action: EventAction.CONSOLIDATE_SUGGEST,
    capability: Capability.CONSOLIDATE,
  },
  // Reviewing what a `suggest`-posture principal wrote costs `consolidate`, not `read`:
  // it is the queue that governs whether those writes stand, and a principal that writes
  // under review must not be able to clear it.
  list_reviews: {
    token: READ_SURFACE.list_reviews,
    kind: "read",
    action: EventAction.REVIEW_PENDING,
    capability: Capability.CONSOLIDATE,
  },
  mirror_status: {
    token: READ_SURFACE.mirror_status,
    kind: "read",
    action: EventAction.MIRROR_STATUS,
    capability: Capability.READ,
  },
  job_status: {
    token: READ_SURFACE.job_status,
    kind: "read",
    action: EventAction.JOB_STATUS,
    capability: Capability.READ,
  },

  // Writes — NEVER retried. None of these is idempotent: a retried `write_memory` after a
  // timeout creates a second node, and a retried `apply_candidate` resolves twice.
  //
  // Classified a write, and it is one: `getSessionHints` calls `requireSession`, which
  // touches `sessions.last_seen`. It reads like a lookup and would have gone to a
  // read-only worker, where it would fail. `audit: false` because it accompanies another
  // call rather than being one — a row of its own would double-count every tool invocation.
  session_hints: {
    token: SESSION_HINTS,
    kind: "write",
    action: EventAction.SEARCH,
    audit: false,
    capability: Capability.READ,
  },
  // Interest, not data: a subscriber states what it wants to hear and nothing is stored,
  // so there is no node and no row worth auditing.
  subscribe_events: {
    token: SUBSCRIBE_EVENTS,
    kind: "write",
    action: EventAction.SEARCH,
    audit: false,
    capability: Capability.READ,
  },
  // Reconciles a near-duplicate draft against the generation provider before it answers,
  // which is what `work` records.
  write_memory: {
    token: WRITE_MEMORY,
    kind: "write",
    action: EventAction.WRITE,
    capability: Capability.WRITE,
    work: RpcWork.GENERATIVE,
  },
  update_memory: {
    token: UPDATE_MEMORY,
    kind: "write",
    action: EventAction.UPDATE,
    capability: Capability.WRITE,
  },
  invalidate_memory: {
    token: INVALIDATE_MEMORY,
    kind: "write",
    action: EventAction.INVALIDATE,
    capability: Capability.WRITE,
  },
  restore_memory: {
    token: RESTORE_MEMORY,
    kind: "write",
    action: EventAction.RESTORE,
    capability: Capability.WRITE,
  },
  link_nodes: {
    token: LINK_NODES,
    kind: "write",
    action: EventAction.LINK,
    capability: Capability.WRITE,
  },
  record_checkpoint: {
    token: RECORD_CHECKPOINT,
    kind: "write",
    action: EventAction.CHECKPOINT,
    capability: Capability.WRITE,
  },
  register_source: {
    token: REGISTER_SOURCE,
    kind: "write",
    action: EventAction.SOURCE_REGISTER,
    capability: Capability.ADMIN,
  },
  upsert_mirrors: {
    token: UPSERT_MIRRORS,
    kind: "write",
    action: EventAction.MIRROR_UPSERT,
    capability: Capability.WRITE,
  },
  apply_candidate: {
    token: APPLY_CANDIDATE,
    kind: "write",
    action: EventAction.CONSOLIDATE_APPLY,
    capability: Capability.CONSOLIDATE,
  },
  resolve_review: {
    token: RESOLVE_REVIEW,
    kind: "write",
    action: EventAction.REVIEW_RESOLVE,
    capability: Capability.CONSOLIDATE,
  },
  retry_candidate: {
    token: RETRY_CANDIDATE,
    kind: "write",
    action: EventAction.CONSOLIDATE_RETRY,
    capability: Capability.CONSOLIDATE,
  },
  // The async form of `index_code`, and it costs the same capability: submitting work is
  // not a cheaper way to ask for something the synchronous call gates behind ADMIN. Which
  // kinds may be named here is enforced by the use case, not by this entry.
  submit_job: {
    token: SUBMIT_JOB,
    kind: "write",
    action: EventAction.JOB_SUBMIT,
    capability: Capability.ADMIN,
  },
  index_code: {
    token: INDEX_CODE,
    kind: "write",
    action: EventAction.CODE_INDEX,
    capability: Capability.ADMIN,
    work: RpcWork.INDEXING,
  },
  // `client` is NOT in this call's argument schema. The identity rides in the transport's
  // `meta`, which the proxy fills from the MCP initialize handshake, so a caller cannot
  // state who it is — only the host process can. Its capability is READ, not WRITE: a
  // principal allowed to read must still be able to open a session to do it in.
  start_session: {
    token: START_SESSION,
    kind: "write",
    action: EventAction.SESSION_START,
    capability: Capability.READ,
  },
} as const;

export type CallName = keyof typeof CALL_SURFACE;
export type CallKind = "read" | "write";

export function isCallName(name: string): name is CallName {
  return Object.hasOwn(CALL_SURFACE, name);
}

export function callKind(name: CallName): CallKind {
  return CALL_SURFACE[name].kind;
}

// A write must never be retried by a client that timed out, so the classification has to be
// legible from the name alone rather than inferred per call site.
export function isRetryable(name: CallName): boolean {
  return CALL_SURFACE[name].kind === "read";
}

// How long a client waits for this call before it reports the daemon unreachable. A call
// that names no `work` is interactive.
export function callDeadlineMs(name: CallName): number {
  const entry = CALL_SURFACE[name];

  return RPC_DEADLINE_MS["work" in entry ? entry.work : RpcWork.INTERACTIVE];
}

export function callAction(name: CallName): EventAction {
  return CALL_SURFACE[name].action;
}

export function callCapability(name: CallName): Capability {
  return CALL_SURFACE[name].capability;
}

// False only for a call that accompanies another rather than being one of its own.
export function isAudited(name: CallName): boolean {
  return !("audit" in CALL_SURFACE[name] && CALL_SURFACE[name].audit === false);
}

// Every read on the call surface must also be dispatchable to the read pool; a read that is
// not in READ_SURFACE would silently run on the main thread instead.
export function readNameOf(name: CallName): ReadName | null {
  return Object.hasOwn(READ_SURFACE, name) ? (name as ReadName) : null;
}
