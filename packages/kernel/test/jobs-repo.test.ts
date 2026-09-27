import { describe, expect, it } from "vitest";
import { JobKind, JobState } from "@cerebrium/contracts/vocab";
import { newId } from "@/core/ids";
import { setup, type TestEnv } from "@test/helpers";

const T0 = "2026-01-01T00:00:00.000Z";
const LEASE_MS = 60_000;

async function submit(env: TestEnv, over: Partial<{ kind: string; scheduled_for: string }> = {}) {
  return await env.jobs.submit({
    id: newId(),
    kind: over.kind ?? JobKind.CODE_INDEX,
    payload: { repo: "cerebrium" },
    scheduled_for: over.scheduled_for ?? T0,
    now: T0,
  });
}

const claim = async (env: TestEnv, owner: string, now = T0) =>
  env.jobs.claim({ kinds: [JobKind.CODE_INDEX], owner, now, leaseMs: LEASE_MS });

describe("JobsRepo", () => {
  it("should store a submitted job as pending with its payload when it is submitted", async () => {
    // Given
    const env = setup();

    // When
    const job = await submit(env);

    // Then
    expect(job.state).toBe(JobState.PENDING);
    expect(job.attempts).toBe(0);
    expect(JSON.parse(job.payload_json)).toEqual({ repo: "cerebrium" });
    expect(job.started_at).toBeNull();
  });

  it("should hand the job to exactly one consumer when two claim at the same instant", async () => {
    // Given
    const env = setup();
    await submit(env);

    // When
    const first = await claim(env, "worker-a");
    const second = await claim(env, "worker-b");

    // Then
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(first!.state).toBe(JobState.RUNNING);
    expect(first!.lease_owner).toBe("worker-a");
    expect(first!.attempts).toBe(1);
  });

  it("should not claim a job whose kind the consumer does not handle when other kinds are queued", async () => {
    // Given
    const env = setup();
    await submit(env, { kind: "agent.digest" });

    // When
    const claimed = await claim(env, "daemon");

    // Then
    expect(claimed).toBeNull();
  });

  it("should not claim a job before its scheduled instant when it is submitted for later", async () => {
    // Given
    const env = setup();
    await submit(env, { scheduled_for: "2026-01-01T01:00:00.000Z" });

    // When
    const early = await claim(env, "daemon", T0);
    const due = await claim(env, "daemon", "2026-01-01T01:00:00.000Z");

    // Then
    expect(early).toBeNull();
    expect(due).not.toBeNull();
  });

  it("should let another consumer take over when the holder's lease has expired", async () => {
    // Given
    const env = setup();
    await submit(env);
    await claim(env, "worker-a");
    const afterExpiry = new Date(Date.parse(T0) + LEASE_MS + 1).toISOString();

    // When
    const taken = await claim(env, "worker-b", afterExpiry);

    // Then
    expect(taken).not.toBeNull();
    expect(taken!.lease_owner).toBe("worker-b");
    expect(taken!.attempts).toBe(2);
  });

  it("should keep the job when the lease is renewed before it expires", async () => {
    // Given
    const env = setup();
    const job = await submit(env);
    await claim(env, "worker-a");
    const halfway = new Date(Date.parse(T0) + LEASE_MS / 2).toISOString();

    // When
    const renewed = await env.jobs.renew(job.id, "worker-a", halfway, LEASE_MS);
    const stolen = await claim(
      env,
      "worker-b",
      new Date(Date.parse(T0) + LEASE_MS + 1).toISOString(),
    );

    // Then
    expect(renewed).toBe(true);
    expect(stolen).toBeNull();
  });

  it("should reject a completion from a consumer that no longer holds the lease when the job was reclaimed", async () => {
    // Given
    const env = setup();
    const job = await submit(env);
    await claim(env, "worker-a");
    const afterExpiry = new Date(Date.parse(T0) + LEASE_MS + 1).toISOString();
    await claim(env, "worker-b", afterExpiry);

    // When
    const late = await env.jobs.succeed(job.id, "worker-a", { ok: true }, afterExpiry);

    // Then
    expect(late).toBe(false);
    expect((await env.jobs.byId(job.id))!.state).toBe(JobState.RUNNING);
    expect((await env.jobs.byId(job.id))!.lease_owner).toBe("worker-b");
  });

  it("should record the result and close the job when it succeeds", async () => {
    // Given
    const env = setup();
    const job = await submit(env);
    await claim(env, "worker-a");

    // When
    const ok = await env.jobs.succeed(job.id, "worker-a", { files: 3 }, T0);

    // Then
    const row = (await env.jobs.byId(job.id))!;
    expect(ok).toBe(true);
    expect(row.state).toBe(JobState.DONE);
    expect(row.lease_owner).toBeNull();
    expect(row.ended_at).toBe(T0);
    expect(JSON.parse(row.result_json!)).toEqual({ files: 3 });
  });

  it("should return the job to pending when it fails with attempts left", async () => {
    // Given
    const env = setup();
    const job = await submit(env);
    await claim(env, "worker-a");

    // When
    await env.jobs.fail(job.id, "worker-a", "transient", T0);

    // Then
    const row = (await env.jobs.byId(job.id))!;
    expect(row.state).toBe(JobState.PENDING);
    expect(row.last_error).toBe("transient");
    expect(row.ended_at).toBeNull();
  });

  it("should retire the job when it fails on its final attempt", async () => {
    // Given
    const env = setup();
    const job = await submit(env);

    // When
    for (let i = 0; i < 3; i++) {
      await claim(env, "worker-a");
      await env.jobs.fail(job.id, "worker-a", `boom ${String(i)}`, T0);
    }

    // Then
    const row = (await env.jobs.byId(job.id))!;
    expect(row.attempts).toBe(3);
    expect(row.state).toBe(JobState.FAILED);
    expect(row.last_error).toBe("boom 2");
    expect(row.ended_at).toBe(T0);
  });

  it("should not claim a job that has exhausted its attempts when a consumer looks for work", async () => {
    // Given
    const env = setup();
    const job = await submit(env);

    for (let i = 0; i < 3; i++) {
      await claim(env, "worker-a");
      await env.jobs.fail(job.id, "worker-a", "boom", T0);
    }

    // When
    const claimed = await claim(env, "worker-a");

    // Then
    expect(claimed).toBeNull();
  });

  it("should reopen an abandoned running job and retire one out of attempts when the consumer boots", async () => {
    // Given
    const env = setup();
    const reopenable = await submit(env);
    const exhausted = await submit(env);

    await claim(env, "dead-worker");
    await env.jobs.claim({
      kinds: [JobKind.CODE_INDEX],
      owner: "dead-worker",
      now: new Date(Date.parse(T0) + LEASE_MS + 1).toISOString(),
      leaseMs: LEASE_MS,
    });
    env.db.prepare("UPDATE jobs SET attempts = max_attempts WHERE id = ?").run(exhausted.id);

    // When
    const touched = await env.jobs.reconcileAbandoned(T0, "the consumer exited mid-job");

    // Then
    expect(touched).toBe(2);
    expect((await env.jobs.byId(reopenable.id))!.state).toBe(JobState.PENDING);
    expect((await env.jobs.byId(exhausted.id))!.state).toBe(JobState.FAILED);
    expect((await env.jobs.byId(exhausted.id))!.ended_at).not.toBeNull();
  });

  it("should report an open job of a kind when one is queued or running, and not when it is done", async () => {
    // Given
    const env = setup();
    const job = await submit(env);

    // When
    const whilePending = await env.jobs.hasOpen(JobKind.CODE_INDEX);
    await claim(env, "worker-a");
    const whileRunning = await env.jobs.hasOpen(JobKind.CODE_INDEX);
    await env.jobs.succeed(job.id, "worker-a", null, T0);
    const afterDone = await env.jobs.hasOpen(JobKind.CODE_INDEX);

    // Then
    expect(whilePending).toBe(true);
    expect(whileRunning).toBe(true);
    expect(afterDone).toBe(false);
  });

  it("should refuse to cancel a job that already reached a terminal state when cancel is called twice", async () => {
    // Given
    const env = setup();
    const job = await submit(env);

    // When
    const first = await env.jobs.cancel(job.id, T0);
    const second = await env.jobs.cancel(job.id, T0);

    // Then
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect((await env.jobs.byId(job.id))!.state).toBe(JobState.CANCELLED);
  });

  it("should count jobs by state when several are in different states", async () => {
    // Given
    const env = setup();
    const done = await submit(env);
    await submit(env);
    await claim(env, "worker-a");
    await env.jobs.succeed(done.id, "worker-a", null, T0);

    // When
    const counts = await env.jobs.counts();

    // Then
    expect(counts).toEqual({ [JobState.DONE]: 1, [JobState.PENDING]: 1 });
  });
});
