export interface ConsolidationTickResult {
  // Set when the sweep stopped between stages because a client was waiting. Not a failure:
  // the completed stages stand and the rest happens on the next tick.
  yielded?: true;
  links_added: number;
  links_suggested: number;
  links_pruned: number;
  // Wikilink edges created, and wikilinks that resolved to nothing — the second is the
  // backlog of nodes named in prose that were never written.
  wikilinks_linked: number;
  wikilinks_dangling: number;
  distilled: number;
  distill_suggested: number;
  merged: number;
  merge_suggested: number;
  merge_delayed: number;
  pruned: number;
  prune_suggested: number;
  proposals_backfilled: number;
  rejected: number;
  annotated: number;
  generation_failures: number;
  last_error: string | null;
  stage?: string;
  // Wall time of each completed stage, in ms. One row per run keeps only the last stage
  // name, so without this the cost of a sweep is not recoverable after it ends.
  stage_ms?: Record<string, number>;
  started_at?: string;
  ended_at?: string | null;
}

export interface ConsolidationReporter {
  reportTick(runId: string, result: ConsolidationTickResult): void;
}

export const CONSOLIDATION_REPORTER_TOKEN = Symbol("ConsolidationReporter");
