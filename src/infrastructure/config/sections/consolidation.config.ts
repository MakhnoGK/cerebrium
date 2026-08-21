import {
  configSection,
  enumOf,
  int,
  nullableStr,
  num,
  SectionOf,
  str,
} from "@/domain/ports/config";
import { Posture } from "@/core/vocab";

// Provider selection and transport. `manual` (default) detects and queues candidates but
// never generates, which is what keeps the suite offline.
// `timeoutMs` is sized from measured generation times on the reference local model, not
// picked: decode dominates (prompt eval averages 1.5 s; the response runs 600–1200 tokens
// at ~19.5 t/s), and a timeout near that band silently discards proposals, since a cut-off
// generation is indistinguishable from a provider with nothing to say.
// `leaseTtlMs` must outlive a single generation call: the worker renews the lease between
// clusters, so anything shorter reads as expired to every observer mid-sweep.
@configSection()
export class ConsolidationConfig extends SectionOf("consolidation", {
  provider: str("manual").env("MEMORY_CONSOLIDATE"),
  url: str("http://127.0.0.1:11434/api/chat").env("MEMORY_CONSOLIDATE_URL"),
  model: str("gemma4:12b-it-qat").env("MEMORY_CONSOLIDATE_MODEL"),
  command: nullableStr(null).env("MEMORY_CONSOLIDATE_CMD"),
  timeoutMs: int(500_000).positive().env("MEMORY_CONSOLIDATE_TIMEOUT_MS"),
  leaseTtlMs: int(600_000).positive().env("MEMORY_CONSOLIDATE_LEASE_TTL_MS"),
  intervalMs: int(300_000).nonNegative().env("MEMORY_CONSOLIDATE_INTERVAL_MS"),
}) {}

// Per-behaviour posture. Balanced defaults: `auto` for the cheap and reversible
// behaviours, `suggest` for the destructive ones.
@configSection()
export class ConsolidationPostureConfig extends SectionOf("consolidation.posture", {
  links: enumOf(Posture, Posture.AUTO).env("MEMORY_CONSOLIDATE_LINKS"),
  linkPrune: enumOf(Posture, Posture.AUTO).env("MEMORY_CONSOLIDATE_LINK_PRUNE"),
  distill: enumOf(Posture, Posture.SUGGEST).env("MEMORY_CONSOLIDATE_DISTILL"),
  merge: enumOf(Posture, Posture.SUGGEST).env("MEMORY_CONSOLIDATE_MERGE"),
  prune: enumOf(Posture, Posture.AUTO).env("MEMORY_CONSOLIDATE_PRUNE"),
  annotate: enumOf(Posture, Posture.AUTO).env("MEMORY_CONSOLIDATE_ANNOTATE"),
  reconcile: enumOf(Posture, Posture.SUGGEST).env("MEMORY_CONSOLIDATE_RECONCILE"),
}) {}

// `mergeSim` is deliberately higher than the write-time dedup probe so merge stays
// conservative; `minCluster` below 2 is not a cluster. Both similarity gates are
// calibrated against a real store by `npm run calibrate:report` — `mergeSim` from the
// applied/dismissed merge record, `sim` from a target edges-per-node density — and both
// are specific to the embedding model in use. `maxLinkDegree` is a degree cap, not a
// similarity gate: it is read from the store's observed similar_to degree distribution.
// `mergeBurstMs` is the burst window: a pair one session wrote inside it is a series its
// writer meant to keep apart, not a duplication, so merge detection lets it age instead
// of proposing it. Measured 2026-08-09 at 7/7 wrong merges blocked for 19% of correct
// ones delayed by a sweep. 0 disables the rule.
@configSection()
export class ConsolidationThresholdsConfig extends SectionOf("consolidation.thresholds", {
  sim: num(0.9).range(0, 1).env("MEMORY_CONSOLIDATE_SIM"),
  mergeSim: num(0.925).range(0, 1).env("MEMORY_CONSOLIDATE_MERGE_SIM"),
  minAgeDays: int(14).nonNegative().env("MEMORY_CONSOLIDATE_MIN_AGE_DAYS"),
  minCluster: int(3).min(2).env("MEMORY_CONSOLIDATE_MIN_CLUSTER"),
  mergeBurstMs: int(3_600_000).nonNegative().env("MEMORY_CONSOLIDATE_MERGE_BURST_MS"),
  maxLinkDegree: int(5).positive().env("MEMORY_CONSOLIDATE_MAX_LINK_DEGREE"),
}) {}

// Per-sweep ceilings; each bounds the work (and generation calls) in one tick.
@configSection()
export class ConsolidationBatchConfig extends SectionOf("consolidation.batch", {
  link: int(200).positive().env("MEMORY_CONSOLIDATE_LINK_BATCH"),
  linkPrune: int(200).positive().env("MEMORY_CONSOLIDATE_LINK_PRUNE_BATCH"),
  distill: int(200).positive().env("MEMORY_CONSOLIDATE_DISTILL_BATCH"),
  merge: int(200).positive().env("MEMORY_CONSOLIDATE_MERGE_BATCH"),
  prune: int(200).positive().env("MEMORY_CONSOLIDATE_PRUNE_BATCH"),
  annotate: int(50).positive().env("MEMORY_CONSOLIDATE_ANNOTATE_BATCH"),
  backfill: int(10).positive().env("MEMORY_CONSOLIDATE_BACKFILL_BATCH"),
  // Note->symbol citations proposed per sweep. Small: they land in a queue a person reads.
  documents: int(25).positive().env("MEMORY_CONSOLIDATE_DOCUMENTS_BATCH"),
  // Items walked between event-loop yields, in every loop the sweep runs — the neighbour
  // pass, link discovery, link pruning, distillation and merge detection. Measured on a
  // 1,975-vector authored pool at 4.8-6.7ms per seed kNN (worst single seed 44.5ms), so
  // the default bounds a waiting client to roughly 120-170ms. Lower trades sweep
  // throughput for read latency.
  itemsPerBreath: int(25).positive().env("MEMORY_CONSOLIDATE_ITEMS_PER_BREATH"),
}) {}
