import { useCaseToken, type UseCase } from "@/application/use-cases/contracts/use-case";
import type { IndexStats } from "@/core/types";

export interface IndexCodeArgs {
  session_id: string;
  repo?: string;
  path?: string;
  force?: boolean;
}

export interface IndexCodeResult {
  results: IndexStats[];
  notes: string[];
}

export type IndexCode = UseCase<IndexCodeArgs, IndexCodeResult>;

export const INDEX_CODE = useCaseToken<IndexCodeArgs, IndexCodeResult>("IndexCode");

export interface ProcessSummary {
  role: string;
  pid: number;
  alive: boolean;
  started_at: string;
  config_state: string;
}

export type StatsSnapshot = UseCase<Record<string, never>, Record<string, unknown>>;

export const STATS_SNAPSHOT = useCaseToken<Record<string, never>, Record<string, unknown>>(
  "StatsSnapshot",
);
