import { describe, it, expect } from "vitest";
import { makeCtx } from "@test/helpers";
import { estimateTokensOf } from "@/core/tokens";
import type { Envelope } from "@/db/repo";
import { SessionStartTool } from "../src/tools/session_start";
import { WriteTool } from "../src/tools/write";
import { CheckpointTool } from "../src/tools/checkpoint";

const session_start = new SessionStartTool();
const write = new WriteTool();
const checkpoint = new CheckpointTool();

const P = "proj";

describe("session_start builds a budgeted working set", () => {
  it("surfaces semantic facts, checkpoint content, and open tasks", async () => {
    const { ctx } = makeCtx();
    const s = (await session_start.invoke(ctx, { project: P })).session_id;
    await write.invoke(ctx, {
      session_id: s,
      memory_kind: "semantic",
      type: "fact",
      title: "Fact 1",
      content: "the sky is blue",
      project: P,
    });
    await write.invoke(ctx, {
      session_id: s,
      memory_kind: "semantic",
      type: "task",
      title: "Task 1",
      content: "ship the thing",
      project: P,
    });
    await checkpoint.invoke(ctx, {
      session_id: s,
      project: P,
      summary: "left off mid-refactor",
      decisions: ["use RRF"],
    });

    const res = await session_start.invoke(ctx, { project: P });
    const ws = res.working_set as {
      semantic: Envelope[];
      checkpoints: { envelope: Envelope; content: string }[];
      tasks: Envelope[];
      stats: { nodes_by_kind: Record<string, number> };
    };

    expect(ws.semantic.map((e) => e.title)).toContain("Fact 1");
    expect(ws.semantic.map((e) => e.title)).not.toContain("Task 1"); // tasks live in their own section
    expect(ws.tasks.map((e) => e.title)).toContain("Task 1");
    expect(ws.checkpoints[0]!.content).toContain("left off mid-refactor");
    expect(ws.stats.nodes_by_kind.semantic).toBe(2);
  });

  it("respects the token budget", async () => {
    const budget = 120;
    const { ctx } = makeCtx({ budget });
    const s = (await session_start.invoke(ctx, { project: P })).session_id;
    for (let i = 0; i < 20; i++) {
      await write.invoke(ctx, {
        session_id: s,
        memory_kind: "semantic",
        type: "fact",
        title: `Fact ${i}`,
        content: `this is a reasonably sized fact number ${i} with enough text to cost some tokens`,
        project: P,
      });
    }

    const res = await session_start.invoke(ctx, { project: P });
    const ws = res.working_set as { semantic: Envelope[] };
    expect(ws.semantic.length).toBeLessThan(20); // budget forced a cut
    const spent = ws.semantic.reduce((sum, e) => sum + estimateTokensOf(e), 0);
    expect(spent).toBeLessThanOrEqual(budget);
  });
});
