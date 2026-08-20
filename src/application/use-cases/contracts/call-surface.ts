import { APPLY_CANDIDATE, RETRY_CANDIDATE } from "@/application/use-cases/contracts/consolidation";
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
import { SESSION_HINTS, START_SESSION } from "@/application/use-cases/contracts/session";
import { EventAction } from "@/core/vocab";

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
  search_memory: { token: READ_SURFACE.search_memory, kind: "read", action: EventAction.SEARCH },
  fetch_nodes: { token: READ_SURFACE.fetch_nodes, kind: "read", action: EventAction.GET },
  lookup_code: { token: READ_SURFACE.lookup_code, kind: "read", action: EventAction.CODE_LOOKUP },
  stats_snapshot: { token: READ_SURFACE.stats_snapshot, kind: "read", action: EventAction.STATS },
  operator_snapshot: {
    token: READ_SURFACE.operator_snapshot,
    kind: "read",
    action: EventAction.STATS,
  },
  suggest_candidates: {
    token: READ_SURFACE.suggest_candidates,
    kind: "read",
    action: EventAction.CONSOLIDATE_SUGGEST,
  },
  mirror_status: {
    token: READ_SURFACE.mirror_status,
    kind: "read",
    action: EventAction.MIRROR_STATUS,
  },

  // Writes — NEVER retried. None of these is idempotent: a retried `write_memory` after a
  // timeout creates a second node, and a retried `apply_candidate` resolves twice.
  //
  // `start_session` is here, and its `client` is NOT in its argument schema. The identity
  // rides in the transport's `meta`, which the proxy fills from the MCP initialize
  // handshake — so a caller cannot state who it is, only the host process can.
  // Classified a write, and it is one: `getSessionHints` calls `requireSession`, which
  // touches `sessions.last_seen`. It reads like a lookup and would have gone to a
  // read-only worker, where it would fail. `audit: false` because it accompanies another
  // call rather than being one — a row of its own would double-count every tool invocation.
  session_hints: { token: SESSION_HINTS, kind: "write", action: EventAction.SEARCH, audit: false },
  write_memory: { token: WRITE_MEMORY, kind: "write", action: EventAction.WRITE },
  update_memory: { token: UPDATE_MEMORY, kind: "write", action: EventAction.UPDATE },
  invalidate_memory: { token: INVALIDATE_MEMORY, kind: "write", action: EventAction.INVALIDATE },
  restore_memory: { token: RESTORE_MEMORY, kind: "write", action: EventAction.RESTORE },
  link_nodes: { token: LINK_NODES, kind: "write", action: EventAction.LINK },
  record_checkpoint: { token: RECORD_CHECKPOINT, kind: "write", action: EventAction.CHECKPOINT },
  register_source: { token: REGISTER_SOURCE, kind: "write", action: EventAction.SOURCE_REGISTER },
  upsert_mirrors: { token: UPSERT_MIRRORS, kind: "write", action: EventAction.MIRROR_UPSERT },
  apply_candidate: { token: APPLY_CANDIDATE, kind: "write", action: EventAction.CONSOLIDATE_APPLY },
  retry_candidate: { token: RETRY_CANDIDATE, kind: "write", action: EventAction.CONSOLIDATE_RETRY },
  index_code: { token: INDEX_CODE, kind: "write", action: EventAction.CODE_INDEX },
  start_session: { token: START_SESSION, kind: "write", action: EventAction.SESSION_START },
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

export function callAction(name: CallName): EventAction {
  return CALL_SURFACE[name].action;
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
