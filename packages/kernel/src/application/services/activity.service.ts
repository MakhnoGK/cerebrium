import { inject, injectable } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";

// When a client last asked for something. The consolidation sweep is background work that
// happens to share a process with the reads, so it needs a signal for "somebody is waiting"
// — and the embedding backlog it already gates on is a different kind of idle entirely.
//
// Measured motivation: with the sweep running, a hybrid search went from 222ms to ~1000ms
// and `status` from 149ms to ~900ms, while the same query in a process without the sweep
// stayed at 211ms.
@injectable()
export class ActivityMonitor {
  private lastCallMs = 0;

  constructor(@inject(CLOCK_TOKEN) private readonly clock: Clock) {}

  note(): void {
    this.lastCallMs = this.nowMs();
  }

  // True when nothing has been asked for in the last `quietMs`. A store that has never
  // been asked anything counts as quiet, so a fresh daemon sweeps rather than waiting for
  // a first client that may never arrive.
  isQuiet(quietMs: number): boolean {
    return this.lastCallMs === 0 || this.nowMs() - this.lastCallMs >= quietMs;
  }

  msSinceLastCall(): number | null {
    return this.lastCallMs === 0 ? null : this.nowMs() - this.lastCallMs;
  }

  private nowMs(): number {
    return Date.parse(this.clock.now());
  }
}
