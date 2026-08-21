import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK_TOKEN } from "@/domain/ports/clock";
import { ActivityMonitor } from "@/application/services";
import { runDaemon } from "@/daemon";
import { setup, type TestEnv } from "@test/helpers";

let env: TestEnv;

beforeEach(() => {
  env = setup();
});

// A sweep that records whether it ran and whether it was told to stop.
function sweeper(yieldAfter = Number.POSITIVE_INFINITY) {
  const calls: { yieldedAt: number | null }[] = [];

  return {
    calls,
    stop: () => Promise.resolve(),
    tick: (opts: { shouldYield?: () => boolean } = {}) => {
      let yieldedAt: number | null = null;

      for (let stage = 1; stage <= 5; stage++) {
        if (stage >= yieldAfter && opts.shouldYield?.() === true) {
          yieldedAt = stage;
          break;
        }
      }

      calls.push({ yieldedAt });

      return Promise.resolve({
        links_added: 0,
        links_suggested: 0,
        links_pruned: 0,
        distilled: 0,
        distill_suggested: 0,
        merged: 0,
        merge_suggested: 0,
        merge_delayed: 0,
        pruned: 0,
        prune_suggested: 0,
        proposals_backfilled: 0,
        rejected: 0,
        annotated: 0,
        generation_failures: 0,
        last_error: null,
        started_at: "2026-01-01T00:00:00.000Z",
      });
    },
  };
}

async function loop(opts: {
  busy?: () => boolean;
  consolidation: ReturnType<typeof sweeper>;
  onSwept?: (result: { links_added: number }) => void;
}) {
  let clock = 0;
  let ticks = 0;

  await runDaemon(env.queue, env.worker, {
    ...(opts.busy === undefined ? {} : { busy: opts.busy }),
    ...(opts.onSwept === undefined ? {} : { onSwept: opts.onSwept }),
    consolidation: opts.consolidation as never,
    consolidateIntervalMs: 0,
    idleExitMs: 50,
    nowMs: () => (clock += 100),
    sleepMs: () => {
      ticks++;

      return Promise.resolve();
    },
  });

  return ticks;
}

describe("Announcing a sweep", () => {
  it("should hand each sweep's result to whoever is publishing it", async () => {
    // Given — the loop holds no socket and must not reach for one; it is told where to
    // send the result.
    const consolidation = sweeper();
    const announced: { links_added: number }[] = [];

    // When
    await loop({
      consolidation,
      onSwept: (result) => {
        announced.push(result);
      },
    });

    // Then
    expect(announced).toHaveLength(consolidation.calls.length);
    expect(announced.length).toBeGreaterThan(0);
  });
});

describe("Activity monitor", () => {
  it("should treat a store nobody has asked anything as quiet", () => {
    // Given — a fresh daemon must sweep rather than wait for a client that may never come.
    const monitor = container.resolve(ActivityMonitor);

    // When / Then
    expect(monitor.isQuiet(1000)).toBe(true);
    expect(monitor.msSinceLastCall()).toBeNull();
  });

  it("should report busy immediately after a call and quiet once the window passes", () => {
    // Given
    const monitor = container.resolve(ActivityMonitor);

    // When
    monitor.note();

    // Then
    expect(monitor.isQuiet(1000)).toBe(false);

    // When — the injected clock moves instead of sleeping.
    env.clock.advanceMs(1000);

    // Then
    expect(monitor.isQuiet(1000)).toBe(true);
  });

  it("should use the injected clock, not wall time", () => {
    // Given
    const monitor = container.resolve(ActivityMonitor);
    container.resolve(CLOCK_TOKEN); // the test clock, already registered by setup()

    // When
    monitor.note();
    env.clock.advanceMs(500);

    // Then
    expect(monitor.msSinceLastCall()).toBe(500);
  });
});

describe("Consolidation backpressure", () => {
  it("should sweep when nothing is waiting", async () => {
    // Given
    const consolidation = sweeper();

    // When
    await loop({ consolidation });

    // Then
    expect(consolidation.calls.length).toBeGreaterThan(0);
  });

  it("should not start a sweep while a client is waiting", async () => {
    // Given — the case the measurement showed: a search costs 5x while the sweep runs.
    const consolidation = sweeper();

    // When
    await loop({ consolidation, busy: () => true });

    // Then
    expect(consolidation.calls).toEqual([]);
  });

  it("should stop a sweep in progress when a client arrives", async () => {
    // Given — quiet at the gate, busy by the third stage.
    const consolidation = sweeper(3);
    let started = false;

    // When
    await loop({
      consolidation,
      busy: () => {
        // Quiet for the gate check, busy for every shouldYield afterwards.
        if (!started) {
          started = true;

          return false;
        }

        return true;
      },
    });

    // Then — it ran, and it stopped part-way rather than holding the CPU to the end.
    expect(consolidation.calls[0]?.yieldedAt).toBe(3);
  });

  it("should keep draining embeddings while it refuses to sweep", async () => {
    // Given — backpressure applies to background consolidation, not to the queue this
    // daemon exists to drain.
    const consolidation = sweeper();

    // When
    const ticks = await loop({ consolidation, busy: () => true });

    // Then
    expect(ticks).toBeGreaterThan(0);
    expect(consolidation.calls).toEqual([]);
  });
});
