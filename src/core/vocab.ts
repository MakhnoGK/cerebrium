// The single source of truth for enum-like vocabularies. Validation and tests
// reference these; extending a list is a normal change, repurposing a value is not.

export const MEMORY_KINDS = ["episodic", "semantic", "mirror"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

// Writable kinds through the `write` tool. `mirror` exists in the schema but is
// non-writable by hand — mirror nodes (code `symbol`s) are maintained by
// the indexer via the repo layer, never through `write`/`update`.
export const WRITABLE_KINDS = ["episodic", "semantic"] as const;
export type WritableKind = (typeof WRITABLE_KINDS)[number];

// Legal node types per memory_kind. `mirror` lists only `symbol` (the code index's
// system-generated type); it stays out of WRITABLE_KINDS (indexer-only). External
// mirror types (`incident`, `thread`, `chart`, …) are OPEN VOCAB —
// agent-supplied via `mirror_upsert` and intentionally not enumerated here, so a new
// source needs no vocab/migration change (like `symbols.symbol_kind`). `mirror_upsert`
// validates only that `type` is a non-empty string, never against this list.
export const NODE_TYPES: Record<MemoryKind, readonly string[]> = {
  episodic: ["checkpoint", "event_note"],
  semantic: ["fact", "decision", "entity", "howto", "task"],
  mirror: ["symbol"],
};

export const EDGE_TYPES = [
  "references",
  "documents",
  "derived_from",
  "supersedes",
  "relates_to",
  "similar_to",
  "imports",
  "calls",
  "defines",
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

// System-only edge types: agents may not create these via the `link` tool. The
// code edges (imports/calls/defines) are drawn only by the indexer; `documents`
// stays agent-creatable — that is the note->code link the agent draws by hand.
export const SYSTEM_EDGE_TYPES = ["similar_to", "imports", "calls", "defines"] as const;

// Consolidation: the kind of a queued consolidation candidate and its
// lifecycle status. `link`/`prune` are deterministic (no generation); `distill`/`merge`
// summarize a cluster. A candidate is resolved by moving off `pending`.
export const CONSOLIDATION_KINDS = ["distill", "merge", "link", "prune"] as const;
export type ConsolidationKind = (typeof CONSOLIDATION_KINDS)[number];

export const CONSOLIDATION_STATUSES = ["pending", "applied", "dismissed"] as const;
export type ConsolidationStatus = (typeof CONSOLIDATION_STATUSES)[number];

export const EVENT_ACTIONS = [
  "session_start",
  "search",
  "get",
  "write",
  "update",
  "invalidate",
  "checkpoint",
  "link",
  "code_index",
  "code_lookup",
  "source_register",
  "mirror_upsert",
  "mirror_status",
  "consolidate_suggest",
  "consolidate_apply",
  "stats",
] as const;
export type EventAction = (typeof EVENT_ACTIONS)[number];

export function typeAllowedForKind(kind: WritableKind, type: string): boolean {
  return NODE_TYPES[kind].includes(type);
}
