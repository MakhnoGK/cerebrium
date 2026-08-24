import { container } from "tsyringe";
import { describe, expect, it, vi } from "vitest";
import { CodeIndexService } from "@/application/services";
import { JobWorker } from "@/application/workers";
import { newId } from "@/core/ids";
import { JobKind, JobState } from "@/core/vocab";
import { runDaemon } from "@/daemon";
import { setup, type TestEnv } from "@test/helpers";

function jobWorker(): JobWorker {
  const service = container.resolve(CodeIndexService);

  vi.spyOn(service, "resolveTargets").mockReturnValue([]);
  vi.spyOn(service, "indexTargets").mockResolvedValue([]);
  container.register(CodeIndexService, { useValue: service });

  return container.resolve(JobWorker);
}

// Runs the loop for a bounded number of passes with time under the test's control, so the
// cadence is asserted rather than waited for.
async function spin(
  env: TestEnv,
  opts: { passes: number; stepMs: number; codeIndexIntervalMs: number; busy?: () => boolean },
) {
  let pass = 0;
  let clock = 0;
  const scheduled: string[] = [];

  await runDaemon(env.queue, env.worker, {
    resident: true,
    stopped: () => pass >= opts.passes,
    sleepMs: () => {
      pass++;

      return Promise.resolve();
    },
    nowMs: () => (clock += opts.stepMs),
    ...(opts.busy === undefined ? {} : { busy: opts.busy }),
    jobs: jobWorker(),
    jobsPerTick: 1,
    codeIndexIntervalMs: opts.codeIndexIntervalMs,
    scheduleCodeIndex: () => {
      if (env.jobs.hasOpen(JobKind.CODE_INDEX)) return;

      const at = env.clock.now();

      scheduled.push(at);
      env.jobs.submit({
        id: newId(),
        kind: JobKind.CODE_INDEX,
        payload: {},
        scheduled_for: at,
        now: at,
      });
    },
  });

  return scheduled;
}

describe("scheduled code-mirror refresh", () => {
  it("should enqueue and run a refresh when the interval has elapsed", async () => {
    // Given
    const env = setup();

    // When
    const scheduled = await spin(env, { passes: 3, stepMs: 1000, codeIndexIntervalMs: 500 });

    // Then
    expect(scheduled.length).toBeGreaterThan(0);
    expect(env.jobs.counts()[JobState.DONE]).toBeGreaterThan(0);
  });

  it("should never enqueue when the interval is zero", async () => {
    // Given
    const env = setup();

    // When
    const scheduled = await spin(env, { passes: 3, stepMs: 100_000, codeIndexIntervalMs: 0 });

    // Then
    expect(scheduled).toEqual([]);
    expect(env.jobs.counts()).toEqual({});
  });

  it("should not stack a second refresh on top of one still queued when the interval fires again", async () => {
    // Given — one already waiting, and a cadence that fires on every pass.
    const env = setup();

    env.jobs.submit({
      id: newId(),
      kind: JobKind.CODE_INDEX,
      payload: {},
      scheduled_for: "2999-01-01T00:00:00.000Z",
      now: env.clock.now(),
    });

    // When
    const scheduled = await spin(env, { passes: 4, stepMs: 10_000, codeIndexIntervalMs: 1 });

    // Then
    expect(scheduled).toEqual([]);
    expect(Object.values(env.jobs.counts()).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("should leave the queue alone while a client is waiting", async () => {
    // Given
    const env = setup();

    env.jobs.submit({
      id: newId(),
      kind: JobKind.CODE_INDEX,
      payload: {},
      scheduled_for: env.clock.now(),
      now: env.clock.now(),
    });

    // When
    await spin(env, {
      passes: 3,
      stepMs: 10_000,
      codeIndexIntervalMs: 1,
      busy: () => true,
    });

    // Then
    expect(env.jobs.counts()).toEqual({ [JobState.PENDING]: 1 });
  });
});
