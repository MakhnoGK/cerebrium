// The single source of truth for enum-like vocabularies. Validation and tests
// reference these; extending a vocabulary is a normal change, repurposing a value is not.

export enum MemoryKind {
  EPISODIC = "episodic",
  SEMANTIC = "semantic",
  MIRROR = "mirror",
}

// Writable kinds through the `write` tool. `mirror` exists in the schema but is
// non-writable by hand — mirror nodes (code `symbol`s) are maintained by
// the indexer via the repo layer, never through `write`/`update`.
export type WritableKind = MemoryKind.EPISODIC | MemoryKind.SEMANTIC;

export const WRITABLE_KINDS = [MemoryKind.EPISODIC, MemoryKind.SEMANTIC] as const;

// Legal node types per memory_kind. `mirror` lists only `symbol` (the code index's
// system-generated type); it stays out of WRITABLE_KINDS (indexer-only). External
// mirror types (`incident`, `thread`, `chart`, …) are OPEN VOCAB — agent-supplied via
// `mirror_upsert` and intentionally not enumerated here, so a new source needs no
// vocab/migration change (like `symbols.symbol_kind`). `mirror_upsert` validates only
// that `type` is a non-empty string, never against this list. Values stay `string` for
// that reason: this is a per-kind allow-list, not a closed vocabulary.
export const SYMBOL_TYPE = "symbol";

export const NODE_TYPES: Record<MemoryKind, readonly string[]> = {
  [MemoryKind.EPISODIC]: ["checkpoint", "event_note"],
  [MemoryKind.SEMANTIC]: ["fact", "decision", "entity", "howto", "task"],
  [MemoryKind.MIRROR]: [SYMBOL_TYPE],
};

// `nodes.origin` for the code index. External mirrors carry their source id instead,
// which is what separates the two vector pools (migration 013): a `mirror` node is only
// code if its origin is this.
export const CODE_ORIGIN = "repo";

export enum EdgeType {
  REFERENCES = "references",
  DOCUMENTS = "documents",
  DERIVED_FROM = "derived_from",
  SUPERSEDES = "supersedes",
  RELATES_TO = "relates_to",
  SIMILAR_TO = "similar_to",
  DUPLICATE_OF = "duplicate_of",
  IMPORTS = "imports",
  CALLS = "calls",
  DEFINES = "defines",
}

// System-only edge types: agents may not create these via the `link` tool. The
// code edges (imports/calls/defines) are drawn only by the indexer; `documents`
// stays agent-creatable — that is the note->code link the agent draws by hand.
// `duplicate_of` suppresses a node at read time, so it is resolved through a
// reviewable consolidation candidate rather than written by hand.
export const SYSTEM_EDGE_TYPES = [
  EdgeType.SIMILAR_TO,
  EdgeType.DUPLICATE_OF,
  EdgeType.IMPORTS,
  EdgeType.CALLS,
  EdgeType.DEFINES,
] as const;

// Consolidation: the kind of a queued consolidation candidate and its
// lifecycle status. `link`/`prune` are deterministic (no generation); `distill`/`merge`
// summarize a cluster. A candidate is resolved by moving off `pending`.
export enum ConsolidationKind {
  DISTILL = "distill",
  MERGE = "merge",
  LINK = "link",
  PRUNE = "prune",
}

// Per-behaviour consolidation posture. `suggest` routes to the candidate queue for an
// agent to review; `auto` applies inline. Balanced defaults ship `auto` for the cheap,
// reversible behaviours (links, Tier-1 prune) and `suggest` for the destructive ones.
export enum Posture {
  OFF = "off",
  SUGGEST = "suggest",
  AUTO = "auto",
}

export enum ConsolidationStatus {
  PENDING = "pending",
  APPLIED = "applied",
  DISMISSED = "dismissed",
}

export enum EventAction {
  SESSION_START = "session_start",
  SEARCH = "search",
  GET = "get",
  WRITE = "write",
  UPDATE = "update",
  INVALIDATE = "invalidate",
  RESTORE = "restore",
  CHECKPOINT = "checkpoint",
  LINK = "link",
  CODE_INDEX = "code_index",
  CODE_LOOKUP = "code_lookup",
  SOURCE_REGISTER = "source_register",
  MIRROR_UPSERT = "mirror_upsert",
  MIRROR_STATUS = "mirror_status",
  CONSOLIDATE_SUGGEST = "consolidate_suggest",
  CONSOLIDATE_APPLY = "consolidate_apply",
  CONSOLIDATE_RETRY = "consolidate_retry",
  CONSOLIDATE_TICK = "consolidate_tick",
  STATS = "stats",
}

export function typeAllowedForKind(kind: WritableKind, type: string): boolean {
  return NODE_TYPES[kind].includes(type);
}
