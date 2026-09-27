import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { ConsolidationWorker } from "@/application/workers";
import { setup, type TestEnv } from "@test/helpers";

const START = "2026-01-01T00:00:00.000Z";
const REASON = "the daemon exited before the sweep finished";

interface RunRow {
  id: string;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  stage: string;
  last_error: string | null;
}

function runs(env: TestEnv): RunRow[] {
  return env.db
    .prepare(
      "SELECT id, started_at, updated_at, ended_at, stage, last_error FROM consolidation_runs",
    )
    .all() as RunRow[];
}

function openRun(env: TestEnv, id: string, at: string, error: string | null = null): void {
  env.consolidation.reportTick(id, {
    started_at: at,
    ended_at: null,
    stage: "merge",
    links_added: 0,
    links_suggested: 0,
    links_pruned: 0,
    wikilinks_linked: 0,
    wikilinks_dangling: 0,
    documents_linked: 0,
    documents_suggested: 0,
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
    last_error: error,
  });
}

describe("A sweep that ends on its own", () => {
  it("should leave the run closed and idle, with nothing open behind it", async () => {
    // Given
    const env = setup({ start: START });

    // When
    await container.resolve(ConsolidationWorker).tick();

    // Then
    const [row] = runs(env);
    expect(row?.stage).toBe("idle");
    expect(row?.ended_at).toBe(START);
    expect(runs(env).filter((r) => r.ended_at === null)).toEqual([]);
  });
});

describe("A sweep the process abandons", () => {
  it("should be closed as interrupted by the stop, so nothing reads as still running", async () => {
    // Given — stopped from inside the sweep, which is what SIGTERM does to a tick that is
    // parked on a generation call.
    const env = setup({ start: START });
    const worker = container.resolve(ConsolidationWorker);

    await worker.tick({
      shouldYield: () => {
        void worker.stop();

        return true;
      },
    });

    // Then
    const [row] = runs(env);
    expect(row?.stage).toBe("interrupted");
    expect(row?.ended_at).toBe(START);
    expect(row?.last_error).toBe("the daemon stopped mid-sweep");
  });

  it("should be closed at the last instant it reported when only the next process can say so", () => {
    // Given — a row left open by a process that was killed outright, plus one that ended
    // properly and must not be touched.
    const env = setup({ start: START });
    openRun(env, "01AAAAAAAAAAAAAAAAAAAAAAAA", START);
    env.clock.advanceMs(60_000);
    env.consolidation.closeRun("01BBBBBBBBBBBBBBBBBBBBBBBB", env.clock.now(), "unrelated");
    openRun(env, "01BBBBBBBBBBBBBBBBBBBBBBBB", START);
    const openedAt = runs(env).find((r) => r.id === "01AAAAAAAAAAAAAAAAAAAAAAAA")!.updated_at;

    // When
    const closed = env.consolidation.closeAbandonedRuns(REASON);

    // Then — `ended_at` is when the sweep last reported, not when this process started.
    expect(closed).toBe(2);

    const row = runs(env).find((r) => r.id === "01AAAAAAAAAAAAAAAAAAAAAAAA")!;
    expect(row.ended_at).toBe(openedAt);
    expect(row.stage).toBe("interrupted");
    expect(row.last_error).toBe(REASON);
    expect(env.consolidation.closeAbandonedRuns(REASON)).toBe(0);
  });

  it("should keep the error a stage already recorded rather than stamping over it", () => {
    // Given
    const env = setup({ start: START });
    openRun(env, "01CCCCCCCCCCCCCCCCCCCCCCCC", START, "generation failed");

    // When
    env.consolidation.closeAbandonedRuns(REASON);

    // Then
    expect(runs(env)[0]?.last_error).toBe("generation failed");
  });

  it("should stay closed when a tick that outlived its own close reports again", () => {
    // Given
    const env = setup({ start: START });
    openRun(env, "01DDDDDDDDDDDDDDDDDDDDDDDD", START);
    env.consolidation.closeRun("01DDDDDDDDDDDDDDDDDDDDDDDD", START, "the daemon stopped mid-sweep");

    // When — the abandoned tick reaches its next stage report before the process dies.
    openRun(env, "01DDDDDDDDDDDDDDDDDDDDDDDD", START);

    // Then
    const [row] = runs(env);
    expect(row?.ended_at).toBe(START);
    expect(row?.stage).toBe("interrupted");
  });
});

describe("Whether a sweep is running", () => {
  it("should come from the lease, not from a run row left open", () => {
    // Given
    const env = setup({ start: START });
    openRun(env, "01EEEEEEEEEEEEEEEEEEEEEEEE", START);

    // Then — an open row is not a running sweep.
    expect(env.stats.techStats(env.clock.now()).consolidation.sweep_running).toBe(false);

    // When
    env.db
      .prepare("INSERT INTO worker_lease (role, owner, expires_at) VALUES (?, ?, ?)")
      .run("consolidation", "owner-1", "2026-01-01T00:10:00.000Z");

    // Then
    const held = env.stats.techStats(env.clock.now()).consolidation;
    expect(held.sweep_running).toBe(true);
    expect(held.sweep_lease_owner).toBe("owner-1");

    // When — the holder's lease lapses without anyone releasing it.
    env.clock.advanceMs(600_000);

    // Then
    expect(env.stats.techStats(env.clock.now()).consolidation.sweep_running).toBe(false);
  });
});
