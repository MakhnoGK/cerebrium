import { describe, expect, it } from "vitest";
import { newId } from "@/core/ids";
import { JobKind, JobState } from "@/core/vocab";
import { setup, type TestEnv } from "@test/helpers";

const T0 = "2026-01-01T00:00:00.000Z";
const LEASE_MS = 60_000;

function submit(env: TestEnv, over: Partial<{ kind: string; scheduled_for: string }> = {}) {
  return env.jobs.submit({
    id: newId(),
    kind: over.kind ?? JobKind.CODE_INDEX,
    payload: { repo: "cerebrium" },
    scheduled_for: over.scheduled_for ?? T0,
    now: T0,
  });
}

const claim = (env: TestEnv, owner: string, now = T0) =>
  env.jobs.claim({ kinds: [JobKind.CODE_INDEX], owner, now, leaseMs: LEASE_MS });

describe("JobsRepo", () => {
  it("should store a submitted job as pending with its payload when it is submitted", () => {
    // Given
    const env = setup();

    // When
    const job = submit(env);

    // Then
    expect(job.state).toBe(JobState.PENDING);
    expect(job.attempts).toBe(0);
    expect(JSON.parse(job.payload_json)).toEqual({ repo: "cerebrium" });
    expect(job.started_at).toBeNull();
  });

  it("should hand the job to exactly one consumer when two claim at the same instant", () => {
    // Given
    const env = setup();
    submit(env);

    // When
    const first = claim(env, "worker-a");
    const second = claim(env, "worker-b");

    // Then
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(first!.state).toBe(JobState.RUNNING);
    expect(first!.lease_owner).toBe("worker-a");
    expect(first!.attempts).toBe(1);
  });

  it("should not claim a job whose kind the consumer does not handle when other kinds are queued", () => {
    // Given
    const env = setup();
    submit(env, { kind: "agent.digest" });

    // When
    const claimed = claim(env, "daemon");

    // Then
    expect(claimed).toBeNull();
  });

  it("should not claim a job before its scheduled instant when it is submitted for later", () => {
    // Given
    const env = setup();
    submit(env, { scheduled_for: "2026-01-01T01:00:00.000Z" });

    // When
    const early = claim(env, "daemon", T0);
    const due = claim(env, "daemon", "2026-01-01T01:00:00.000Z");

    // Then
    expect(early).toBeNull();
    expect(due).not.toBeNull();
  });

  it("should let another consumer take over when the holder's lease has expired", () => {
    // Given
    const env = setup();
    submit(env);
    claim(env, "worker-a");
    const afterExpiry = new Date(Date.parse(T0) + LEASE_MS + 1).toISOString();

    // When
    const taken = claim(env, "worker-b", afterExpiry);

    // Then
    expect(taken).not.toBeNull();
    expect(taken!.lease_owner).toBe("worker-b");
    expect(taken!.attempts).toBe(2);
  });

  it("should keep the job when the lease is renewed before it expires", () => {
    // Given
    const env = setup();
    const job = submit(env);
    claim(env, "worker-a");
    const halfway = new Date(Date.parse(T0) + LEASE_MS / 2).toISOString();

    // When
    const renewed = env.jobs.renew(job.id, "worker-a", halfway, LEASE_MS);
    const stolen = claim(env, "worker-b", new Date(Date.parse(T0) + LEASE_MS + 1).toISOString());

    // Then
    expect(renewed).toBe(true);
    expect(stolen).toBeNull();
  });

  it("should reject a completion from a consumer that no longer holds the lease when the job was reclaimed", () => {
    // Given
    const env = setup();
    const job = submit(env);
    claim(env, "worker-a");
    const afterExpiry = new Date(Date.parse(T0) + LEASE_MS + 1).toISOString();
    claim(env, "worker-b", afterExpiry);

    // When
    const late = env.jobs.succeed(job.id, "worker-a", { ok: true }, afterExpiry);

    // Then
    expect(late).toBe(false);
    expect(env.jobs.byId(job.id)!.state).toBe(JobState.RUNNING);
    expect(env.jobs.byId(job.id)!.lease_owner).toBe("worker-b");
  });

  it("should record the result and close the job when it succeeds", () => {
    // Given
    const env = setup();
    const job = submit(env);
    claim(env, "worker-a");

    // When
    const ok = env.jobs.succeed(job.id, "worker-a", { files: 3 }, T0);

    // Then
    const row = env.jobs.byId(job.id)!;
    expect(ok).toBe(true);
    expect(row.state).toBe(JobState.DONE);
    expect(row.lease_owner).toBeNull();
    expect(row.ended_at).toBe(T0);
    expect(JSON.parse(row.result_json!)).toEqual({ files: 3 });
  });

  it("should return the job to pending when it fails with attempts left", () => {
    // Given
    const env = setup();
    const job = submit(env);
    claim(env, "worker-a");

    // When
    env.jobs.fail(job.id, "worker-a", "transient", T0);

    // Then
    const row = env.jobs.byId(job.id)!;
    expect(row.state).toBe(JobState.PENDING);
    expect(row.last_error).toBe("transient");
    expect(row.ended_at).toBeNull();
  });

  it("should retire the job when it fails on its final attempt", () => {
    // Given
    const env = setup();
    const job = submit(env);

    // When
    for (let i = 0; i < 3; i++) {
      claim(env, "worker-a");
      env.jobs.fail(job.id, "worker-a", `boom ${String(i)}`, T0);
    }

    // Then
    const row = env.jobs.byId(job.id)!;
    expect(row.attempts).toBe(3);
    expect(row.state).toBe(JobState.FAILED);
    expect(row.last_error).toBe("boom 2");
    expect(row.ended_at).toBe(T0);
  });

  it("should not claim a job that has exhausted its attempts when a consumer looks for work", () => {
    // Given
    const env = setup();
    const job = submit(env);

    for (let i = 0; i < 3; i++) {
      claim(env, "worker-a");
      env.jobs.fail(job.id, "worker-a", "boom", T0);
    }

    // When
    const claimed = claim(env, "worker-a");

    // Then
    expect(claimed).toBeNull();
  });

  it("should reopen an abandoned running job and retire one out of attempts when the consumer boots", () => {
    // Given
    const env = setup();
    const reopenable = submit(env);
    const exhausted = submit(env);

    claim(env, "dead-worker");
    env.jobs.claim({
      kinds: [JobKind.CODE_INDEX],
      owner: "dead-worker",
      now: new Date(Date.parse(T0) + LEASE_MS + 1).toISOString(),
      leaseMs: LEASE_MS,
    });
    env.db.prepare("UPDATE jobs SET attempts = max_attempts WHERE id = ?").run(exhausted.id);

    // When
    const touched = env.jobs.reconcileAbandoned(T0, "the consumer exited mid-job");

    // Then
    expect(touched).toBe(2);
    expect(env.jobs.byId(reopenable.id)!.state).toBe(JobState.PENDING);
    expect(env.jobs.byId(exhausted.id)!.state).toBe(JobState.FAILED);
    expect(env.jobs.byId(exhausted.id)!.ended_at).not.toBeNull();
  });

  it("should report an open job of a kind when one is queued or running, and not when it is done", () => {
    // Given
    const env = setup();
    const job = submit(env);

    // When
    const whilePending = env.jobs.hasOpen(JobKind.CODE_INDEX);
    claim(env, "worker-a");
    const whileRunning = env.jobs.hasOpen(JobKind.CODE_INDEX);
    env.jobs.succeed(job.id, "worker-a", null, T0);
    const afterDone = env.jobs.hasOpen(JobKind.CODE_INDEX);

    // Then
    expect(whilePending).toBe(true);
    expect(whileRunning).toBe(true);
    expect(afterDone).toBe(false);
  });

  it("should refuse to cancel a job that already reached a terminal state when cancel is called twice", () => {
    // Given
    const env = setup();
    const job = submit(env);

    // When
    const first = env.jobs.cancel(job.id, T0);
    const second = env.jobs.cancel(job.id, T0);

    // Then
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(env.jobs.byId(job.id)!.state).toBe(JobState.CANCELLED);
  });

  it("should count jobs by state when several are in different states", () => {
    // Given
    const env = setup();
    const done = submit(env);
    submit(env);
    claim(env, "worker-a");
    env.jobs.succeed(done.id, "worker-a", null, T0);

    // When
    const counts = env.jobs.counts();

    // Then
    expect(counts).toEqual({ [JobState.DONE]: 1, [JobState.PENDING]: 1 });
  });
});
