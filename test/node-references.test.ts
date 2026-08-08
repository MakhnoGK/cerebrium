import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { EdgeType, MemoryKind } from "@/core/vocab";
import { CheckpointTool } from "@/presentation/mcp/tools/checkpoint";
import { InvalidateTool } from "@/presentation/mcp/tools/invalidate";
import { LinkTool } from "@/presentation/mcp/tools/link";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup, type TestEnv } from "@test/helpers";

interface CreatedNode {
  id: string;
}

describe("live node references", () => {
  let env: TestEnv;
  let sessionId: string;
  let write: WriteTool;

  beforeEach(async () => {
    env = setup();
    sessionId = (await container.resolve(SessionStartTool).invoke({ project: "refs" })).session_id;
    write = container.resolve(WriteTool);
  });

  const create = (
    title: string,
    parentNodeId: string | null,
    links?: { dst: string; type: EdgeType }[],
  ) =>
    write.invoke({
      session_id: sessionId,
      parent_node_id: parentNodeId,
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title,
      content: `${title} content`,
      project: "refs",
      links,
    }) as Promise<CreatedNode>;

  it("should leave explicitly isolated writes unrelated even in the same session", async () => {
    await create("First", null);
    await create("Second", null);

    const edges = (env.db.prepare("SELECT COUNT(*) AS c FROM edges").get() as { c: number }).c;

    expect(edges).toBe(0);
  });

  it("should atomically relate a write to its explicit parent without duplicating the edge", async () => {
    const parent = await create("Parent", null);
    const child = await create("Child", parent.id, [{ dst: parent.id, type: EdgeType.RELATES_TO }]);

    const rows = env.db
      .prepare(
        "SELECT src, dst, type FROM edges WHERE src = ? AND dst = ? AND invalidated_at IS NULL",
      )
      .all(child.id, parent.id);

    expect(rows).toStrictEqual([{ src: child.id, dst: parent.id, type: EdgeType.RELATES_TO }]);
  });

  it("should reject a stale parent with the terminal live successor and roll back the write", async () => {
    const first = await create("First", null);
    const second = await create("Second", null);
    const terminal = await create("Terminal", null);
    const invalidate = container.resolve(InvalidateTool);
    await invalidate.invoke({
      session_id: sessionId,
      id: first.id,
      reason: "replaced",
      superseded_by: second.id,
    });
    await invalidate.invoke({
      session_id: sessionId,
      id: second.id,
      reason: "replaced again",
      superseded_by: terminal.id,
    });
    const before = (env.db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c;

    await expect(create("Rejected", first.id)).rejects.toThrow(
      `parent node ${first.id} is invalidated. Use live successor ${terminal.id}.`,
    );

    expect((env.db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c).toBe(
      before,
    );
  });

  it("should reject stale ids in explicit links and checkpoint references", async () => {
    const stale = await create("Stale", null);
    const live = await create("Live", null);
    await container.resolve(InvalidateTool).invoke({
      session_id: sessionId,
      id: stale.id,
      reason: "replaced",
      superseded_by: live.id,
    });

    await expect(
      create("Bad link", null, [{ dst: stale.id, type: EdgeType.DOCUMENTS }]),
    ).rejects.toThrow(`Use live successor ${live.id}`);
    await expect(
      container.resolve(LinkTool).invoke({
        session_id: sessionId,
        src: live.id,
        dst: stale.id,
        type: EdgeType.REFERENCES,
      }),
    ).rejects.toThrow(`Use live successor ${live.id}`);
    await expect(
      container.resolve(CheckpointTool).invoke({
        session_id: sessionId,
        title: "handoff",
        summary: "handoff",
        touched_node_ids: [stale.id],
      }),
    ).rejects.toThrow(`Use live successor ${live.id}`);
  });
});
