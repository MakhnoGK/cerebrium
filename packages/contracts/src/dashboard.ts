import type { ConsolidationCandidate, TechStats } from "@cerebrium/contracts/types";

// The wire between the dashboard's backend and its browser app. The backend shapes what the
// kernel answers into these; nothing here is a kernel call.

export interface ProbeResult {
  ok: boolean;
  error: string | null;
}

export interface DaemonHealth extends ProbeResult {
  protocol: number | null;
  pid: number | null;
  model: string | null;
}

export interface OllamaHealth extends ProbeResult {
  url: string;
  models: string[];
}

export interface DashboardProcess {
  role: string;
  pid: number;
  alive: boolean;
  started_at: string;
  model_state: string | null;
  model_error: string | null;
}

export interface DashboardJob {
  id: string;
  kind: string;
  state: string;
  attempts: number;
  max_attempts: number;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  last_error: string | null;
}

export interface GenerationStatus {
  provider: string;
  enabled: boolean;
  model: string | null;
}

export interface DashboardStatus {
  generated_at: string;
  // False when the backend cannot reach the daemon; every other field is then the last
  // value it had, or empty.
  kernel_connected: boolean;
  daemon: DaemonHealth;
  ollama: OllamaHealth;
  generation: GenerationStatus | null;
  stats: TechStats | null;
  processes: DashboardProcess[];
  jobs: DashboardJob[];
  review_pending: number | null;
}

// One audited call, as the event log records it.
export interface ActivityEntry {
  id: string | null;
  ts: string;
  action: string;
  session_id: string;
  node_id: string | null;
  principal: string | null;
  client: string | null;
  ok: boolean;
  detail: unknown;
}

export interface IntegrityCounters {
  wikilinks_by_id: number;
  wikilinks_dangling_id: number;
  reattached: number;
  links_typed: number;
  links_dropped: number;
  links_to_review: number;
  superseded?: number;
  edges_repointed: number;
}

export interface ConsolidationRunSummary {
  id: string;
  started_at: string;
  ended_at: string | null;
  stage: string;
  links_added: number;
  links_pruned: number;
  distilled: number;
  distill_suggested: number;
  merged: number;
  merge_suggested: number;
  pruned: number;
  annotated: number;
  proposals_backfilled: number;
  documents_linked: number;
  generation_failures: number;
  last_error: string | null;
  integrity: IntegrityCounters | null;
}

export interface ActivityPage {
  events: ActivityEntry[];
  runs: ConsolidationRunSummary[];
}

export interface SweptNotice {
  links_added: number;
  wikilinks_linked: number;
  wikilinks_dangling: number;
  distill_suggested: number;
  merge_suggested: number;
  prune_suggested: number;
  reattached: number;
  links_typed: number;
  yielded: boolean;
}

// What `/api/stream` sends, one server-sent event per item: the SSE `event` field is `type`
// and its `data` is `data` as JSON.
export type StreamEvent =
  | { type: "activity"; data: ActivityEntry }
  | { type: "consolidation"; data: SweptNotice }
  | { type: "status"; data: DashboardStatus };

// A node as the review screens show it: enough to compare members side by side.
export interface NodePreview {
  id: string;
  found: boolean;
  title: string | null;
  type: string | null;
  memory_kind: string | null;
  project: string | null;
  content: string | null;
  invalidated: boolean;
}

export interface CandidateView {
  candidate: ConsolidationCandidate;
  // In `member_ids` order; for documents the second is a code symbol.
  members: NodePreview[];
}

export interface CandidatePage {
  candidates: CandidateView[];
  next_cursor: string | null;
}

// `collapse` applies to merge only: false records the pair as duplicates and keeps both;
// true rewrites the survivor from `override` (or the proposal) and retires the other.
export interface CandidateDecisionBody {
  decision: "apply" | "reject";
  override?: { title: string; summary: string; body: string };
  collapse?: boolean;
}

export interface CandidateDecisionResult {
  id: string;
  status: string;
  kind: string;
}

export interface ReviewNode {
  id: string;
  type: string;
  title: string;
}

// A write that already landed under a `suggest` posture: a node, or an edge `src|dst|type`.
export interface ReviewItemView {
  artifact: "edge" | "node";
  ref: string;
  principal: string | null;
  at: string;
  edge_type?: string;
  src?: ReviewNode;
  dst?: ReviewNode;
  node?: ReviewNode;
}

export interface ReviewPage {
  items: ReviewItemView[];
  pending: { edges: number; nodes: number };
}

export interface ReviewDecisionBody {
  artifact: "edge" | "node";
  ref: string;
  decision: "kept" | "undone";
  note?: string;
}

export interface ReviewDecisionResult {
  ref: string;
  decision: string;
  undone: boolean;
}
