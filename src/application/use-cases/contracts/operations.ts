import type { ConfigFileReport, FieldProvenance } from "@/domain/ports/config";
import { useCaseToken, type UseCase } from "@/application/use-cases/contracts/use-case";
import type { IndexStats, TechStats } from "@/core/types";

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

// The operator view: everything `cerebrium-stats` and the GUI render, which is strictly
// more than the compact snapshot the agent-facing `stats` tool returns. Serving it from
// one use case is what lets the CLI print the same report whether it read the database
// itself or asked the daemon over the socket.
export interface OperatorSnapshotResult extends TechStats {
  drain: TechStats["drain"] & {
    provider: string;
    daemon_alive: boolean;
    daemon_pid: number | null;
  };
  processes: OperatorProcess[];
  config: {
    file: ConfigFileReport | null;
    values: Record<string, Record<string, unknown>>;
    provenance: FieldProvenance[];
    ignored: string[];
  };
}

export interface OperatorProcess {
  role: string;
  pid: number;
  alive: boolean;
  started_at: string;
  config_state: string;
  model_state: string | null;
  model_ms: number | null;
  model_error: string | null;
}

export type OperatorSnapshot = UseCase<Record<string, never>, OperatorSnapshotResult>;

export const OPERATOR_SNAPSHOT = useCaseToken<Record<string, never>, OperatorSnapshotResult>(
  "OperatorSnapshot",
);
