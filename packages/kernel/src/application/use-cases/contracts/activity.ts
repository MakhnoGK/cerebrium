import type { ActivityEntry, ConsolidationRunSummary } from "@cerebrium/contracts/dashboard";
import { useCaseToken, type UseCase } from "@/application/use-cases/contracts/use-case";

export interface RecentActivityArgs {
  session_id?: string;
  limit?: number;
  // Events strictly older than this instant, for paging back.
  before?: string;
}

export interface RecentActivityResult {
  events: ActivityEntry[];
  runs: ConsolidationRunSummary[];
}

// The audit log and the sweep history, newest first: what an operator reads to see what
// the memory has been doing.
export type RecentActivity = UseCase<RecentActivityArgs, RecentActivityResult>;

export const RECENT_ACTIVITY = useCaseToken<RecentActivityArgs, RecentActivityResult>(
  "RecentActivity",
);
