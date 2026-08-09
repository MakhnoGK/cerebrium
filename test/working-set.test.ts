import { container } from "tsyringe";
import { afterEach, describe, expect, it } from "vitest";
import type { Envelope } from "@/db/repo";
import { estimateTokensOf } from "@/core/tokens";
import { MemoryKind } from "@/core/vocab";
import { CheckpointTool } from "@/presentation/mcp/tools/checkpoint";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup } from "@test/helpers";

const P = "proj";

function tools() {
  return {
    sessionStart: container.resolve(SessionStartTool),
    write: container.resolve(WriteTool),
    checkpoint: container.resolve(CheckpointTool),
  };
}

afterEach(() => {
  delete process.env.MEMORY_WORKING_SET_TOKENS;
});

describe("session_start builds a budgeted working set", () => {
  it("should surface semantic facts, checkpoint content, and open tasks when a session starts", async () => {
    // Given
    setup();
    const t = tools();
    const s = (await t.sessionStart.invoke({ project: P })).session_id;
    await t.write.invoke({
      session_id: s,
      parent_node_id: null,
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title: "Fact 1",
      content: "the sky is blue",
      project: P,
    });
    await t.write.invoke({
      session_id: s,
      parent_node_id: null,
      memory_kind: MemoryKind.SEMANTIC,
      type: "task",
      title: "Task 1",
      content: "ship the thing",
      project: P,
    });
    await t.checkpoint.invoke({
      session_id: s,
      project: P,
      title: "left off mid-refactor",
      summary: "left off mid-refactor",
      decisions: ["use RRF"],
    });

    // When
    const res = await t.sessionStart.invoke({ project: P });

    // Then
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

  it("should cut the working set to fit when the token budget is small", async () => {
    // Given
    const budget = 120;
    process.env.MEMORY_WORKING_SET_TOKENS = String(budget);
    setup();
    const t = tools();
    const s = (await t.sessionStart.invoke({ project: P })).session_id;
    for (let i = 0; i < 20; i++) {
      await t.write.invoke({
        session_id: s,
        parent_node_id: null,
        memory_kind: MemoryKind.SEMANTIC,
        type: "fact",
        title: `Fact ${i}`,
        content: `this is a reasonably sized fact number ${i} with enough text to cost some tokens`,
        project: P,
      });
    }

    // When
    const res = await t.sessionStart.invoke({ project: P });

    // Then
    const ws = res.working_set as { semantic: Envelope[] };
    expect(ws.semantic.length).toBeLessThan(20); // budget forced a cut
    const spent = ws.semantic.reduce((sum, e) => sum + estimateTokensOf(e), 0);
    expect(spent).toBeLessThanOrEqual(budget);
  });
});
