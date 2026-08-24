import { bool, configSection, int, SectionOf } from "@/domain/ports/config";

// The kernel's own work queue and the one recurring job it schedules for itself.
//
// `codeIndexIntervalMs` is the cadence at which the daemon enqueues a refresh of the code
// mirror. Twelve hours, not nightly: the mirror going stale is what makes `code_lookup`
// answer about a file that no longer looks like that, and a refresh of an unchanged repo is
// hash-gated down to nothing. Zero turns the schedule off and leaves the queue purely
// caller-driven.
//
// `maxPerTick` is 1 deliberately. The daemon runs jobs on the thread that answers the
// socket, so a tick that took several would hold reads for the sum of them; the loop comes
// back around immediately when the queue still has work.
@configSection()
export class JobsConfig extends SectionOf("jobs", {
  enabled: bool(true).env("MEMORY_JOBS"),
  codeIndexIntervalMs: int(43_200_000).nonNegative().env("MEMORY_JOBS_CODE_INDEX_MS"),
  maxPerTick: int(1).positive().env("MEMORY_JOBS_MAX_PER_TICK"),
}) {}
