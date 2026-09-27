import type { TechStats } from "@cerebrium/contracts/types";

export const STATS_REPO_TOKEN = Symbol("StatsRepo");

export interface StatsRepo {
  stats(): Promise<{
    nodes_by_kind: Record<string, number>;
    last_activity: string | null;
    embedding: { backlog: number; parked: number };
  }>;
  dbPath(): Promise<string>;
  techStats(now: string): Promise<TechStats>;
}
