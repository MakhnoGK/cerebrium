import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { AgentRunService } from "@/application/services";
import type { AgentRunReport } from "@/application/use-cases";
import { newId } from "@/core/ids";
import { JobKind, JobState, MemoryKind } from "@/core/vocab";
import { setup, type TestEnv } from "@test/helpers";

const T0 = "2026-01-01T00:00:00.000Z";
const OWNER = "runner-1";

const REPORT: AgentRunReport = {
  exit: "completed",
  result: '{"session":"01M0","hits":1}',
  cost_usd: 0.0554,
  turns: 3,
  duration_ms: 6349,
  model: "claude-haiku-4-5-20251001",
  permission_denials: 0,
  error: null,
  usage: {
    input_tokens: 6,
    output_tokens: 173,
    cache_creation_input_tokens: 33677,
    cache_read_input_tokens: 52731,
  },
};

const service = () => container.resolve(AgentRunService);

const queue = (env: TestEnv, kind: string = JobKind.AGENT_SELFTEST) =>
  env.jobs.submit({ id: newId(), kind, payload: {}, scheduled_for: T0, now: T0 });

const runNotes = (env: TestEnv) =>
  env.db
    .prepare("SELECT id, title FROM nodes WHERE type = 'event_note' AND memory_kind = ?")
    .all(MemoryKind.EPISODIC) as { id: string; title: string }[];

describe("AgentRunService", () => {
  it("should claim an agent job when one is queued", () => {
    // Given
    const env = setup();
    queue(env);

    // When
    const job = service().claim([JobKind.AGENT_SELFTEST], OWNER);

    // Then
    expect(job).not.toBeNull();
    expect(job!.state).toBe(JobState.RUNNING);
    expect(job!.lease_owner).toBe(OWNER);
  });

  it("should refuse to claim kernel work even when asked for it directly", () => {
    // Given — a code.index job waiting, and a runner that names it explicitly.
    const env = setup();
    queue(env, JobKind.CODE_INDEX);

    // When
    const job = service().claim([JobKind.CODE_INDEX, JobKind.AGENT_SELFTEST], OWNER);

    // Then
    expect(job).toBeNull();
    expect(env.jobs.byId(env.jobs.recent({ limit: 1 })[0]!.id)!.state).toBe(JobState.PENDING);
  });

  it("should close the job and record the run when a completed report arrives", async () => {
    // Given
    const env = setup();
    const job = queue(env);

    service().claim([JobKind.AGENT_SELFTEST], OWNER);

    // When
    const ok = await service().finish(job.id, OWNER, REPORT);

    // Then
    expect(ok).toBe(true);
    expect(env.jobs.byId(job.id)!.state).toBe(JobState.DONE);

    const notes = runNotes(env);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toContain("agent.selftest run completed");
    expect(notes[0]!.title).toContain("$0.0554");
  });

  it("should record what the run spent even when it failed, because that spend is real", async () => {
    // Given
    const env = setup();
    const job = queue(env);

    service().claim([JobKind.AGENT_SELFTEST], OWNER);

    // When
    await service().finish(job.id, OWNER, {
      ...REPORT,
      exit: "timeout",
      error: "wall clock exceeded",
    });

    // Then
    const notes = runNotes(env);
    expect(notes[0]!.title).toContain("timeout");

    const body = env.db
      .prepare("SELECT content FROM revisions WHERE node_id = ? ORDER BY rev DESC LIMIT 1")
      .get(notes[0]!.id) as { content: string };

    expect(body.content).toContain("wall clock exceeded");
    expect(body.content).toContain("86,587 tokens");
  });

  it("should leave the job retryable when a run fails with attempts to spare", async () => {
    // Given
    const env = setup();
    const job = queue(env);

    service().claim([JobKind.AGENT_SELFTEST], OWNER);

    // When
    await service().finish(job.id, OWNER, { ...REPORT, exit: "failed", error: "boom" });

    // Then
    expect(env.jobs.byId(job.id)!.state).toBe(JobState.PENDING);
  });

  it("should reject a report from a runner that no longer holds the lease", async () => {
    // Given
    const env = setup();
    const job = queue(env);

    service().claim([JobKind.AGENT_SELFTEST], OWNER);

    // When
    const ok = await service().finish(job.id, "someone-else", REPORT);

    // Then
    expect(ok).toBe(false);
    expect(env.jobs.byId(job.id)!.state).toBe(JobState.RUNNING);
    expect(runNotes(env)).toHaveLength(0);
  });

  it("should attribute the run record to the system, not to the runner or the human", async () => {
    // Given
    const env = setup();
    const job = queue(env);

    service().claim([JobKind.AGENT_SELFTEST], OWNER);

    // When
    await service().finish(job.id, OWNER, REPORT);

    // Then
    const clients = (
      env.db.prepare("SELECT DISTINCT client FROM sessions").all() as { client: string | null }[]
    ).map((r) => r.client);

    expect(clients).toContain("cerebrium-jobs");
    expect(clients).not.toContain("claude-code");
  });
});

describe("AgentRunService.enqueue", () => {
  it("should queue an agent job the call surface refuses to take", () => {
    // Given
    const env = setup();

    // When
    const job = service().enqueue(JobKind.AGENT_SELFTEST, { why: "verification" })!;

    // Then
    expect(job.state).toBe(JobState.PENDING);
    expect(env.jobs.byId(job.id)!.kind).toBe(JobKind.AGENT_SELFTEST);
    expect(JSON.parse(env.jobs.byId(job.id)!.payload_json)).toEqual({ why: "verification" });
  });

  it("should refuse kernel work, which belongs on the call surface instead", () => {
    // Given
    setup();

    // When / Then
    expect(() => service().enqueue(JobKind.CODE_INDEX, {})).toThrow(/goes through submit_job/);
  });

  it("should be claimable by the runner as soon as it is queued", () => {
    // Given
    setup();
    const job = service().enqueue(JobKind.AGENT_SELFTEST, {})!;

    // When
    const claimed = service().claim([JobKind.AGENT_SELFTEST], OWNER);

    // Then
    expect(claimed?.id).toBe(job.id);
  });
});

describe("AgentRunService.enqueue on a cadence", () => {
  const HOUR = 3_600_000;

  it("should queue recurring work when the kind has never run", () => {
    // Given
    setup();

    // When
    const job = service().enqueue(JobKind.AGENT_DOCUMENTS, {}, HOUR);

    // Then
    expect(job).not.toBeNull();
    expect(job!.kind).toBe(JobKind.AGENT_DOCUMENTS);
  });

  it("should queue nothing while one of its kind is still open", () => {
    // Given
    setup();
    const first = service().enqueue(JobKind.AGENT_DOCUMENTS, {}, HOUR);

    // When
    const second = service().enqueue(JobKind.AGENT_DOCUMENTS, {}, HOUR);

    // Then
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("should queue nothing when the last run ended more recently than the cadence", async () => {
    // Given
    const env = setup();
    const first = service().enqueue(JobKind.AGENT_DOCUMENTS, {}, HOUR)!;
    const claimed = service().claim([JobKind.AGENT_DOCUMENTS], OWNER)!;

    await service().finish(claimed.id, OWNER, REPORT);

    // When
    const second = service().enqueue(JobKind.AGENT_DOCUMENTS, {}, HOUR);

    // Then
    expect(env.jobs.byId(first.id)!.ended_at).not.toBeNull();
    expect(second).toBeNull();
  });

  it("should queue again once the cadence has elapsed since the last run ended", async () => {
    // Given
    const env = setup();
    const first = service().enqueue(JobKind.AGENT_DOCUMENTS, {}, HOUR)!;
    const claimed = service().claim([JobKind.AGENT_DOCUMENTS], OWNER)!;

    await service().finish(claimed.id, OWNER, REPORT);
    env.db
      .prepare("UPDATE jobs SET ended_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", first.id);

    // When
    const second = service().enqueue(JobKind.AGENT_DOCUMENTS, {}, HOUR);

    // Then
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first.id);
  });

  it("should still queue unconditionally when no cadence is named, which is what --once does", () => {
    // Given
    setup();
    service().enqueue(JobKind.AGENT_DOCUMENTS, {}, HOUR);

    // When
    const forced = service().enqueue(JobKind.AGENT_DOCUMENTS, {});

    // Then
    expect(forced).not.toBeNull();
  });
});
