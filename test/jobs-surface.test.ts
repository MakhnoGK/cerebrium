import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { UnsubmittableJobKindError } from "@/application/errors";
import {
  callCapability,
  JOB_STATUS,
  SUBMIT_JOB,
  type JobStatus,
  type SubmitJob,
} from "@/application/use-cases";
import { ClientIdentity } from "@/runtime/client-identity";
import { Capability, JobKind, JobState } from "@/core/vocab";
import { setup } from "@test/helpers";

const submitter = () => container.resolve<SubmitJob>(SUBMIT_JOB);
const status = () => container.resolve<JobStatus>(JOB_STATUS);
const SESSION = "01M0PHDX6C60XPFTCCSYPETR33";

describe("job call surface", () => {
  it("should queue the job and stamp the submitting principal when a kernel kind is submitted", async () => {
    // Given
    const env = setup();
    container.resolve(ClientIdentity).set({ client: "claude-code", version: "1" });

    // When
    const { job } = await submitter().invoke({
      session_id: SESSION,
      kind: JobKind.CODE_INDEX,
      payload: { repo: "cerebrium" },
    });

    // Then
    expect(job.state).toBe(JobState.PENDING);
    expect(job.kind).toBe(JobKind.CODE_INDEX);
    expect(env.jobs.byId(job.id)!.submitted_by).toBe("claude-code");
  });

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
    setup();
    const { job } = await submitter().invoke({ session_id: SESSION, kind: JobKind.CODE_INDEX });
    await submitter().invoke({ session_id: SESSION, kind: JobKind.CODE_INDEX });

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
    const { job } = await submitter().invoke({ session_id: SESSION, kind: JobKind.CODE_INDEX });

    env.jobs.claim({
      kinds: [JobKind.CODE_INDEX],
      owner: "daemon",
      now: env.clock.now(),
      leaseMs: 1000,
    });
    env.jobs.succeed(job.id, "daemon", { files_indexed: 4 }, env.clock.now());

    // When
    const { jobs } = await status().invoke({ id: job.id });

    // Then
    expect(jobs[0]!.state).toBe(JobState.DONE);
    expect(jobs[0]!.result).toEqual({ files_indexed: 4 });
  });

  it("should cap how many rows one status call returns when a large limit is asked for", async () => {
    // Given
    setup();

    for (let i = 0; i < 3; i++) {
      await submitter().invoke({ session_id: SESSION, kind: JobKind.CODE_INDEX });
    }

    // When
    const { jobs } = await status().invoke({ limit: 5000 });

    // Then
    expect(jobs).toHaveLength(3);
  });
});
