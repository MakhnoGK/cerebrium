import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { Capability, JobKind, JobState } from "@cerebrium/contracts/vocab";
import { UnsubmittableJobKindError } from "@/application/errors";
import {
  callCapability,
  JOB_STATUS,
  SUBMIT_JOB,
  type JobStatus,
  type SubmitJob,
} from "@/application/use-cases";
import { newId } from "@/core/ids";
import { setup, type TestEnv } from "@test/helpers";

const submitter = () => container.resolve<SubmitJob>(SUBMIT_JOB);
const status = () => container.resolve<JobStatus>(JOB_STATUS);
const SESSION = "01M0PHDX6C60XPFTCCSYPETR33";

const queue = (env: TestEnv) =>
  env.jobs.submit({
    id: newId(),
    kind: JobKind.AGENT_SELFTEST,
    payload: {},
    scheduled_for: env.clock.now(),
    now: env.clock.now(),
  });

describe("job call surface", () => {
  it("should refuse an agent kind naming why when a caller tries to enqueue external work", async () => {
    // Given
    setup();

    // When / Then
    await expect(submitter().invoke({ session_id: SESSION, kind: "agent.digest" })).rejects.toThrow(
      UnsubmittableJobKindError,
    );
    await expect(submitter().invoke({ session_id: SESSION, kind: "agent.digest" })).rejects.toThrow(
      /enqueued by the host that runs it/,
    );
  });

  it("should refuse a code index job when the store has no code index", async () => {
    // Given
    setup();

    // When
    const submitted = submitter().invoke({ session_id: SESSION, kind: JobKind.CODE_INDEX });

    // Then
    await expect(submitted).rejects.toThrow("not available on the postgres backend");
  });

  it("should refuse an unknown kind when a caller invents one", async () => {
    // Given
    setup();

    // When / Then
    await expect(submitter().invoke({ session_id: SESSION, kind: "nonsense" })).rejects.toThrow(
      /Unknown job kind/,
    );
  });

  it("should cost the same capability as the synchronous call it defers when submit_job is compared to index_code", () => {
    // Given / When / Then
    expect(callCapability("submit_job")).toBe(Capability.ADMIN);
    expect(callCapability("submit_job")).toBe(callCapability("index_code"));
    expect(callCapability("job_status")).toBe(Capability.READ);
  });

  it("should return just that job when status is asked for one id", async () => {
    // Given
    const env = setup();
    const job = await queue(env);
    await queue(env);

    // When
    const { jobs } = await status().invoke({ id: job.id });

    // Then
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe(job.id);
  });

  it("should return nothing rather than fail when status is asked for an id that does not exist", async () => {
    // Given
    setup();

    // When
    const { jobs } = await status().invoke({ id: "01M0PHDX6C60XPFTCCSYPETR34" });

    // Then
    expect(jobs).toEqual([]);
  });

  it("should report the stored result parsed when a finished job is read back", async () => {
    // Given
    const env = setup();
    const job = await queue(env);

    await env.jobs.claim({
      kinds: [JobKind.AGENT_SELFTEST],
      owner: "runner",
      now: env.clock.now(),
      leaseMs: 1000,
    });
    await env.jobs.succeed(job.id, "runner", { files_indexed: 4 }, env.clock.now());

    // When
    const { jobs } = await status().invoke({ id: job.id });

    // Then
    expect(jobs[0]!.state).toBe(JobState.DONE);
    expect(jobs[0]!.result).toEqual({ files_indexed: 4 });
  });

  it("should cap how many rows one status call returns when a large limit is asked for", async () => {
    // Given
    const env = setup();

    for (let i = 0; i < 3; i++) {
      await queue(env);
    }

    // When
    const { jobs } = await status().invoke({ limit: 5000 });

    // Then
    expect(jobs).toHaveLength(3);
  });
});
