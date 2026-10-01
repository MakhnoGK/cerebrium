import type { ActivityEntry } from "@cerebrium/contracts/dashboard";

// Shared by both backends: the SELECT lists and the row shapes they return.

export const RUN_SUMMARY_COLUMNS = `id, started_at, ended_at, stage, links_added, links_pruned,
  distilled, distill_suggested, merged, merge_suggested, pruned, annotated,
  proposals_backfilled, documents_linked, generation_failures, last_error`;

export interface EventRow {
  id: string;
  ts: string;
  action: string;
  session_id: string;
  node_id: string | null;
  detail: string | null;
  client: string | null;
  principal: string | null;
}

function parsed(raw: string | null): unknown {
  if (raw === null) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function activityOf(row: EventRow): ActivityEntry {
  const detail = parsed(row.detail);
  const failed =
    typeof detail === "object" && detail !== null && "error" in (detail as Record<string, unknown>);

  return { ...row, detail, ok: !failed };
}
