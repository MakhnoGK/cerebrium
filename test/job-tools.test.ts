import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { JobState } from "@/core/vocab";
import { JobStatusTool } from "@/presentation/mcp/tools/job-status";
import { JobSubmitTool } from "@/presentation/mcp/tools/job-submit";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { setup } from "@test/helpers";

const submitTool = () => container.resolve(JobSubmitTool);
const statusTool = () => container.resolve(JobStatusTool);

const session = async () => (await container.resolve(SessionStartTool).invoke({})).session_id;

describe("job tools", () => {
  it("should answer with the queued job when work is submitted", async () => {
    // Given
    setup();
    const session_id = await session();

    // When
    const job = await submitTool().invoke({
      session_id,
      kind: "code.index",
      payload: { repo: "cerebrium" },
    });

    // Then
    expect(job).toMatchObject({ kind: "code.index", state: JobState.PENDING, attempts: 0 });
    expect(job.id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });

  it("should answer with the job itself rather than a list of one when polled by id", async () => {
    // Given
    setup();
    const session_id = await session();
    const submitted = await submitTool().invoke({ session_id, kind: "code.index" });

    // When
    const polled = await statusTool().invoke({ session_id, id: submitted.id });

    // Then
    expect(polled).not.toHaveProperty("jobs");
    expect(polled).toMatchObject({ id: submitted.id });
  });

  it("should answer with a list when no id is given", async () => {
    // Given
    setup();
    const session_id = await session();
    await submitTool().invoke({ session_id, kind: "code.index" });
    await submitTool().invoke({ session_id, kind: "code.index" });

    // When
    const listed = await statusTool().invoke({ session_id });

    // Then
    expect(listed).toHaveProperty("jobs");
    expect((listed as { jobs: unknown[] }).jobs).toHaveLength(2);
  });

  it("should answer with an empty list rather than fail when polled for an id that never existed", async () => {
    // Given
    setup();
    const session_id = await session();

    // When
    const polled = await statusTool().invoke({ session_id, id: "01M0PHDX6C60XPFTCCSYPETR34" });

    // Then
    expect(polled).toEqual({ jobs: [] });
  });

  it("should refuse to enqueue external work through the tool surface when an agent kind is named", async () => {
    // Given
    setup();
    const session_id = await session();

    // When / Then
    await expect(submitTool().invoke({ session_id, kind: "agent.digest" })).rejects.toThrow(
      /enqueued by the host that runs it/,
    );
  });
});
