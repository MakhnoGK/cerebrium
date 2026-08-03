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
@configSection()
export class ConsolidationConfig extends SectionOf("consolidation", {
  provider: str("manual").env("MEMORY_CONSOLIDATE"),
  url: str("http://127.0.0.1:11434/api/chat").env("MEMORY_CONSOLIDATE_URL"),
  model: str("gemma4:12b-it-qat").env("MEMORY_CONSOLIDATE_MODEL"),
  command: nullableStr(null).env("MEMORY_CONSOLIDATE_CMD"),
  timeoutMs: int(60_000).positive().env("MEMORY_CONSOLIDATE_TIMEOUT_MS"),
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
@configSection()
export class ConsolidationThresholdsConfig extends SectionOf("consolidation.thresholds", {
  sim: num(0.9).range(0, 1).env("MEMORY_CONSOLIDATE_SIM"),
  mergeSim: num(0.925).range(0, 1).env("MEMORY_CONSOLIDATE_MERGE_SIM"),
  minAgeDays: int(14).nonNegative().env("MEMORY_CONSOLIDATE_MIN_AGE_DAYS"),
  minCluster: int(3).min(2).env("MEMORY_CONSOLIDATE_MIN_CLUSTER"),
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
}) {}
