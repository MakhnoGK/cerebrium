// Consolidation configuration — read at point of use from env (no central config
// module in this codebase; mirrors dedupThreshold() and the MEMORY_DAEMON_* idioms).
// Per-behavior posture is independently tunable; the Balanced defaults ship auto for the
// cheap/reversible behaviors (links, Tier-1 prune) and suggest for the destructive ones
// (distillation, merge).

export type Posture = "off" | "suggest" | "auto";

function posture(value: string | undefined, fallback: Posture): Posture {
  return value === "off" || value === "suggest" || value === "auto" ? value : fallback;
}

export function linksPosture(): Posture {
  return posture(process.env.MEMORY_CONSOLIDATE_LINKS, "auto");
}
export function distillPosture(): Posture {
  return posture(process.env.MEMORY_CONSOLIDATE_DISTILL, "suggest");
}
export function mergePosture(): Posture {
  return posture(process.env.MEMORY_CONSOLIDATE_MERGE, "suggest");
}
export function prunePosture(): Posture {
  return posture(process.env.MEMORY_CONSOLIDATE_PRUNE, "auto");
}

// Write-time dedup reconcile. `suggest` (default) surfaces a judged action in the write
// response for the agent to apply; `off` disables the judgment (the advisory
// `similar_existing` hint still fires). `auto` is intentionally treated as `suggest`
// here — the write tool never mutates the graph on the agent's behalf.
export function reconcilePosture(): Posture {
  return posture(process.env.MEMORY_CONSOLIDATE_RECONCILE, "suggest");
}

// Attribute enrichment. `auto` (default) generates + folds attributes into
// FTS during the sweep; `off` skips it. `suggest` has no meaning here (an annotation is a
// non-destructive index enrichment with nothing to review) and is treated as `auto`.
export function annotatePosture(): Posture {
  return posture(process.env.MEMORY_CONSOLIDATE_ANNOTATE, "auto");
}

// Max un-annotated semantic nodes enriched per sweep (bounds generation calls per tick;
// each is one annotate() round-trip).
export function annotateBatch(): number {
  return Number(process.env.MEMORY_CONSOLIDATE_ANNOTATE_BATCH) || 50;
}

// Cosine-similarity floor for clustering + link discovery.
export function simThreshold(): number {
  return Number(process.env.MEMORY_CONSOLIDATE_SIM) || 0.85;
}

// Minimum gap between consolidation sweeps (the daemon ticks consolidation only when
// the embedding backlog is empty, and no more than once per interval).
export function consolidateIntervalMs(): number {
  return Number(process.env.MEMORY_CONSOLIDATE_INTERVAL_MS) || 300_000;
}

// Max candidate nodes examined for link discovery per sweep (bounds re-scan work).
export function linkBatch(): number {
  return Number(process.env.MEMORY_CONSOLIDATE_LINK_BATCH) || 200;
}

// Distillation: an episodic must be at least this old (decayed) before it is eligible
// to roll up, and a cluster needs at least this many members to be worth distilling.
export function minAgeDays(): number {
  return Number(process.env.MEMORY_CONSOLIDATE_MIN_AGE_DAYS) || 14;
}
export function minCluster(): number {
  return Number(process.env.MEMORY_CONSOLIDATE_MIN_CLUSTER) || 3;
}
export function distillBatch(): number {
  return Number(process.env.MEMORY_CONSOLIDATE_DISTILL_BATCH) || 200;
}

// Dedup/merge: similarity floor for treating two semantic nodes as duplicates —
// deliberately higher than the write-time dedup probe (0.82) so merge is conservative.
export function mergeSimThreshold(): number {
  return Number(process.env.MEMORY_CONSOLIDATE_MERGE_SIM) || 0.92;
}
export function mergeBatch(): number {
  return Number(process.env.MEMORY_CONSOLIDATE_MERGE_BATCH) || 200;
}

// Tier-1 mirror prune: max dead mirror nodes reconciled per sweep.
export function pruneBatch(): number {
  return Number(process.env.MEMORY_CONSOLIDATE_PRUNE_BATCH) || 200;
}

// Backfill: max pending distill/merge candidates a newly-enabled provider drafts
// proposals for per sweep (each is one generation call — kept modest so a tick stays
// bounded; raise it to blast through a large manual-era backlog after switching to http).
export function backfillBatch(): number {
  return Number(process.env.MEMORY_CONSOLIDATE_BACKFILL_BATCH) || 10;
}
