import type { TechStats } from "@cerebrium/contracts/types";

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
  yielded: boolean;
}

// What `/api/stream` sends, one server-sent event per item: the SSE `event` field is `type`
// and its `data` is `data` as JSON.
export type StreamEvent =
  | { type: "activity"; data: ActivityEntry }
  | { type: "consolidation"; data: SweptNotice }
  | { type: "status"; data: DashboardStatus };
