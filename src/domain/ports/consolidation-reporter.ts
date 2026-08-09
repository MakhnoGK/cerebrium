export interface ConsolidationTickResult {
  links_added: number;
  links_suggested: number;
  links_pruned: number;
  distilled: number;
  distill_suggested: number;
  merged: number;
  merge_suggested: number;
  pruned: number;
  prune_suggested: number;
  proposals_backfilled: number;
  rejected: number;
  annotated: number;
  generation_failures: number;
  last_error: string | null;
  stage?: string;
  started_at?: string;
  ended_at?: string | null;
}

export interface ConsolidationReporter {
  reportTick(runId: string, result: ConsolidationTickResult): void;
}

export const CONSOLIDATION_REPORTER_TOKEN = Symbol("ConsolidationReporter");
