import { container } from "tsyringe";
import { describe, expect, it, vi } from "vitest";
import { CodeIndexService } from "@/application/services";
import { JobWorker } from "@/application/workers";
import { newId } from "@/core/ids";
import { JobKind, JobState } from "@/core/vocab";
import { setup, type TestEnv } from "@test/helpers";

const T0 = "2026-01-01T00:00:00.000Z";

// The indexer is stubbed: this suite is about the queue's discipline, not about parsing a
// repo. `indexTargets` is the only thing a handler reaches for.
function worker(index?: () => Promise<unknown>): JobWorker {
  if (index !== undefined) {
    const service = container.resolve(CodeIndexService);

    vi.spyOn(service, "resolveTargets").mockReturnValue([]);
    vi.spyOn(service, "indexTargets").mockImplementation(
      index as unknown as CodeIndexService["indexTargets"],
    );
    container.register(CodeIndexService, { useValue: service });
  }

  return container.resolve(JobWorker);
}

const queue = (env: TestEnv, kind: string = JobKind.CODE_INDEX) =>
  env.jobs.submit({
    id: newId(),
    kind,
    payload: { repo: "cerebrium" },
    scheduled_for: T0,
    now: T0,
  });

describe("JobWorker", () => {
  it("should claim only the kinds it declares when the queue holds work for another consumer", () => {
    // Given
    setup();

    // When / Then
    expect(worker().kinds).toEqual([JobKind.CODE_INDEX]);
  });

  it("should run the job and store the handler's result when a code index is queued", async () => {
    // Given
    const env = setup();
    const job = queue(env);
    const w = worker(() => Promise.resolve([{ repo: "cerebrium", files_indexed: 2 }]));

    // When
    const result = await w.tick();

    // Then
    const row = env.jobs.byId(job.id)!;
    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(row.state).toBe(JobState.DONE);
    expect(JSON.parse(row.result_json!)).toEqual({
      results: [{ repo: "cerebrium", files_indexed: 2 }],
    });
  });

  it("should open a session naming itself rather than the submitter when it runs a job", async () => {
    // Given
    const env = setup();
    queue(env);

    // When
    await worker(() => Promise.resolve([])).tick();

    // Then
    const clients = (
      env.db.prepare("SELECT DISTINCT client FROM sessions").all() as { client: string | null }[]
    ).map((r) => r.client);
    expect(clients).toContain("cerebrium-jobs");
  });

  it("should record the failure and leave the job retryable when the handler throws", async () => {
    // Given
    const env = setup();
    const job = queue(env);

    // When
    const result = await worker(() => Promise.reject(new Error("disk on fire"))).tick();

    // Then
    const row = env.jobs.byId(job.id)!;
    expect(result).toMatchObject({ claimed: 1, succeeded: 0, failed: 1 });
    expect(row.state).toBe(JobState.PENDING);
    expect(row.last_error).toBe("disk on fire");
    expect(row.attempts).toBe(1);
  });

  it("should stop before claiming anything when a client is already waiting", async () => {
    // Given
    const env = setup();
    const job = queue(env);

    // When
    const result = await worker(() => Promise.resolve([])).tick({ shouldYield: () => true });

    // Then
    expect(result).toMatchObject({ claimed: 0, yielded: true });
    expect(env.jobs.byId(job.id)!.state).toBe(JobState.PENDING);
  });

  it("should take no more than the tick's cap when several jobs are queued", async () => {
    // Given
    const env = setup();
    queue(env);
    queue(env);
    queue(env);

    // When
    const result = await worker(() => Promise.resolve([])).tick({ max: 2 });

    // Then
    expect(result.claimed).toBe(2);
    expect(env.jobs.counts()).toEqual({ [JobState.DONE]: 2, [JobState.PENDING]: 1 });
  });

  it("should report an empty tick rather than fail when the queue holds nothing for it", async () => {
    // Given
    const env = setup();
    queue(env, "agent.digest");

    // When
    const result = await worker(() => Promise.resolve([])).tick();

    // Then
    expect(result).toMatchObject({ claimed: 0, succeeded: 0, failed: 0, yielded: false });
  });

  it("should reopen a job left running by a process that died when the runner reconciles at boot", () => {
    // Given
    const env = setup();
    const job = queue(env);

    env.jobs.claim({ kinds: [JobKind.CODE_INDEX], owner: "dead", now: T0, leaseMs: 60_000 });

    // When
    const reopened = worker().reconcile();

    // Then
    expect(reopened).toBe(1);
    expect(env.jobs.byId(job.id)!.state).toBe(JobState.PENDING);
  });

  it("should treat an unparseable payload as empty rather than crash the tick", async () => {
    // Given
    const env = setup();
    const job = queue(env);

    env.db.prepare("UPDATE jobs SET payload_json = ? WHERE id = ?").run("{not json", job.id);

    // When
    await worker(() => Promise.resolve([])).tick();

    // Then
    expect(env.jobs.byId(job.id)!.state).toBe(JobState.DONE);
  });
});
