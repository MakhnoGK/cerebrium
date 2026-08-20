import { singleton } from "tsyringe";
import { QuotaExceededError } from "@/application/errors";
import type { PrincipalUsage } from "@/core/types";
import { Capability } from "@/core/vocab";
import type { PrincipalQuota } from "@/infrastructure/config";

const DEFAULT_WINDOW_MS = 3_600_000;

interface Call {
  at: number;
  write: boolean;
}

// Sliding-window rate limiting per principal, held in memory. The daemon is the single
// process every host calls through, so counting here is exact for the deployment that
// matters, costs no write per call, and resets when the daemon does — which is the right
// lifetime for a rate limit.
@singleton()
export class PrincipalQuotaService {
  private readonly calls = new Map<string, Call[]>();

  // The limiter is process-wide, so it outlives a container re-registration; a test that
  // does not clear it would spend the previous test's budget.
  reset(): void {
    this.calls.clear();
  }

  // Records the call and throws if it puts the principal over. Consumption happens before
  // the call runs, so a call that then fails still counts against the limit.
  consume(principal: string, capability: Capability, quota: PrincipalQuota, now: number): void {
    if (quota.calls === undefined && quota.writes === undefined) return;

    const windowMs = quota.windowMs ?? DEFAULT_WINDOW_MS;
    const write = capability === Capability.WRITE;
    const recent = this.recent(principal, now - windowMs);

    this.exceeded(recent, quota.calls, (c) => c.length, principal, "calls", windowMs, now);

    // The write ceiling gates writes only: a writer that has spent its authoring budget
    // must still be able to read the store it is writing into.
    if (write) {
      this.exceeded(
        recent,
        quota.writes,
        (c) => c.filter((entry) => entry.write).length,
        principal,
        "writes",
        windowMs,
        now,
      );
    }

    recent.push({ at: now, write });
  }

  usage(now: number, windowMs = DEFAULT_WINDOW_MS): PrincipalUsage[] {
    return [...this.calls.keys()]
      .map((principal) => {
        const recent = this.recent(principal, now - windowMs);

        return {
          principal,
          calls: recent.length,
          writes: recent.filter((entry) => entry.write).length,
        };
      })
      .filter((entry) => entry.calls > 0);
  }

  private recent(principal: string, since: number): Call[] {
    const kept = (this.calls.get(principal) ?? []).filter((entry) => entry.at > since);

    this.calls.set(principal, kept);

    return kept;
  }

  private exceeded(
    recent: Call[],
    limit: number | undefined,
    count: (calls: Call[]) => number,
    principal: string,
    label: string,
    windowMs: number,
    now: number,
  ): void {
    if (limit === undefined) return;

    const matching = count(recent);

    if (matching < limit) return;

    // The window frees up when its oldest matching call ages out, which is what a caller
    // needs to know rather than the window length.
    const oldest = recent.find((entry) => (label === "writes" ? entry.write : true))?.at ?? now;

    throw new QuotaExceededError(principal, label, Math.max(0, oldest + windowMs - now));
  }
}
