import type {
  ConsolidationKind,
  ConsolidationStatus,
  EdgeType,
  EventAction,
  MemoryKind,
} from "@/core/vocab";

// Domain types shared across the repository layer and the tools. Pure — no db or
// process imports — so both the data layer and callers depend inward on these.

export interface Envelope {
  id: string;
  kind: MemoryKind;
  type: string;
  title: string;
  summary: string;
  project: string | null;
  updated: string;
  rev: number;
  edges: number;
  invalidated: boolean;
}

// One addressable section of a node's body: the heading path chunks were filed under
// (or the preamble sentinel), and the size of the text behind it.
export interface NodeSection {
  section: string;
  chars: number;
}

export interface NeighborStub {
  id: string;
  type: string;
  title: string;
  edge: string;
  direction: "out" | "in";
}

export interface RevisionMeta {
  rev: number;
  ts: string;
  session_id: string;
  reason: string | null;
}

export interface EnrichedRow {
  id: string;
  memory_kind: MemoryKind;
  type: string;
  title: string;
  project: string | null;
  valid_from: string;
  invalidated_at: string | null;
  rev: number;
  updated: string;
  content: string;
  edge_count: number;
  use_count: number;
  last_used_at: string | null;
}

export interface SearchRow extends EnrichedRow {
  bm25: number;
}

export interface VectorRow extends EnrichedRow {
  distance: number; // cosine distance in [0,2]; cosine similarity = 1 - distance
  chunk_text: string;
  chunk_heading: string | null; // heading path of the matched chunk; null before the first heading
}

export interface QueueRow {
  node_id: string;
  enqueued_at: string;
  attempts: number;
}

// A pre-generated distill/merge summary attached to a candidate; null until a
// generation provider runs (or when the agent will author it at apply time).
// `recommendation`/`reason` carry the provider's verdict on whether to consolidate at
// all (absent on agent-authored or pre-recommendation proposals).
export interface ConsolidationProposal {
  title: string;
  summary: string;
  body: string;
  recommendation?: "apply" | "reject";
  reason?: string;
}

// A queued consolidation candidate. `member_ids` is the cluster the sweep
// found; `canonical_id` is the merge survivor / link dst when applicable.
export interface ConsolidationCandidate {
  id: string;
  kind: ConsolidationKind;
  status: ConsolidationStatus;
  project: string | null;
  member_ids: string[];
  canonical_id: string | null;
  score: number;
  proposal: ConsolidationProposal | null;
  detected_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

export interface NewCandidate {
  kind: ConsolidationKind;
  project?: string | null;
  member_ids: string[];
  canonical_id?: string | null;
  score: number;
  proposal?: ConsolidationProposal | null;
  detected_at: string;
}

export interface UnembeddedChunk {
  id: string;
  node_id: string;
  text: string;
}

export interface TechStats {
  queue: {
    backlog: number;
    parked: number;
    total: number;
    with_errors: number;
    oldest_enqueued_at: string | null;
    attempts_histogram: Record<string, number>;
  };
  content: {
    nodes_by_kind: Record<string, number>;
    nodes_total: number;
    edges: number;
    chunks_active: number;
    chunks_stale: number;
    chunks_embedded: number;
    chunks_unembedded: number;
    sessions: number;
    events: number;
  };
  storage: {
    db_path: string;
    db_bytes: number;
    wal_bytes: number;
    page_count: number;
    page_size: number;
  };
  drain: {
    lease_owner: string | null;
    lease_expires_at: string | null;
    lease_active: boolean;
  };
  rerank_usage: {
    eligible_searches: number; // hybrid/vector searches (the rerank-eligible ones)
    reranked_searches: number; // of those, how many actually reranked
    candidates_reranked: number; // total candidates scored across all rerank passes
  };
  code_repos: RepoProvenance[];
  last_activity: string | null;
}

export interface RepoProvenance {
  repo: string;
  root: string | null;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
  indexed_at: string;
}

export interface Neighbor {
  parent: string;
  edge: EdgeType;
  node: EnrichedRow;
}

export interface NewNode {
  memory_kind: MemoryKind;
  type: string;
  title: string;
  content: string;
  project: string | null;
  session_id: string;
  ts: string;
  links?: { dst: string; type: EdgeType }[];
  // Event axis — when the fact itself was true, independent of when it was written down.
  // Absent means no claim; reads treat that as an open interval.
  event_from?: string;
  event_to?: string;
}

// ---- code indexing --------------------------------------------------------

// One symbol extracted from source. `external_id` is the stable symbol id
// (sha256 prefix of repo\0path\0qualified\0symbol_kind); `summary` becomes the
// node's revision content (FTS + embedded); `source` is the raw slice (get-only).
export interface ExtractedSymbol {
  external_id: string;
  symbol_kind: string;
  name: string;
  qualified: string;
  signature: string | null;
  summary: string;
  start_line: number;
  end_line: number;
  code_hash: string;
  source: string;
}

export interface FileIndexInput {
  repo: string;
  path: string;
  lang: string;
  fileHash: string;
  symbols: ExtractedSymbol[];
  defines: { src: string; dst: string }[]; // container external_id -> member external_id (both local)
  session_id: string;
  ts: string;
}

export interface FileIndexResult {
  added: number;
  updated: number;
  invalidated: number;
  edges: number;
}

export interface SymbolDirEntry {
  node_id: string;
  path: string;
  name: string;
  qualified: string;
  symbol_kind: string;
}

export interface SymbolFacets {
  repo: string;
  path: string;
  lang: string;
  symbol_kind: string;
  name: string;
  qualified: string;
  signature: string | null;
  start_line: number;
  end_line: number;
}

export interface SymbolLookup {
  envelope: Envelope;
  facets: SymbolFacets;
  neighbors: NeighborStub[];
}

// A repo to index: the name symbol identity is content-addressed on, and the
// directory to walk.
export interface IndexTarget {
  name: string;
  root: string;
}

// The compact per-repo summary an index run returns — counts and provenance, never
// symbols or source.
export interface IndexStats {
  repo: string;
  files_scanned: number;
  files_indexed: number;
  files_skipped: number;
  symbols_added: number;
  symbols_updated: number;
  symbols_invalidated: number;
  edges_written: number;
  duration_ms: number;
  parked_embeddings: number;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
}

// ---- external mirrors ------------------------------------------------------

// A registered external mirror source (a row in `mirror_sources`). `kind` becomes
// each mirror node's `origin`; `id` is the deployment-local instance (e.g.
// 'grafana-prod'). Empty registry in a fresh clone -> no active sources.
export interface MirrorSource {
  id: string;
  kind: string;
  label: string | null;
  project: string | null;
  freshness_hours: number | null;
  recipe: string | null;
  enabled: boolean;
  last_synced_at: string | null;
  registered_at: string;
}

// A source plus its computed freshness + live node count (for `mirror_status` and
// the session_start freshness hook). `stale` is only true for an enabled source
// with a `freshness_hours` threshold that has been exceeded (or never synced).
export interface MirrorSourceStatus extends MirrorSource {
  hours_stale: number | null; // null when never synced
  stale: boolean;
  node_count: number;
}

// One curated external record the agent asks to mirror. `content` is a compact
// markdown summary the agent composed from the source; `url` is a deep link back;
// `facets` is opaque structured metadata. Idempotent by (source, native_id).
export interface MirrorItem {
  native_id: string;
  type: string;
  title: string;
  content: string;
  url?: string;
  project?: string;
  facets?: Record<string, unknown>;
}

export interface MirrorUpsertResult {
  source_id: string;
  added: number;
  updated: number;
  unchanged: number;
  node_ids: string[];
}

// The per-record facet row (mirror_records) for an external mirror node, returned
// alongside content by `get`.
export interface MirrorRecord {
  source_id: string;
  native_id: string;
  url: string | null;
  facets: Record<string, unknown> | null;
}

// One row of the `events` audit log: what a caller did, in one session. Callers
// describe the event; the writer stamps `ts` from the clock.
export interface EventDraft {
  action: EventAction;
  session_id: string;
  node_id?: string | null;
  detail?: unknown;
}

const SUMMARY_MAX = 160;

export function deriveSummary(content: string): string {
  const line = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
  if (!line) return "";
  return line.length > SUMMARY_MAX ? line.slice(0, SUMMARY_MAX).trimEnd() + "…" : line;
}

export function toEnvelope(row: EnrichedRow): Envelope {
  return {
    id: row.id,
    kind: row.memory_kind,
    type: row.type,
    title: row.title,
    summary: deriveSummary(row.content),
    project: row.project,
    updated: row.updated,
    rev: row.rev,
    edges: row.edge_count,
    invalidated: row.invalidated_at != null,
  };
}
