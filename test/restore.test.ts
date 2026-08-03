import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import type { Envelope } from "@/db/repo";
import { EdgeType, MemoryKind } from "@/core/vocab";
import { GetTool } from "@/presentation/mcp/tools/get";
import { InvalidateTool } from "@/presentation/mcp/tools/invalidate";
import { RestoreTool } from "@/presentation/mcp/tools/restore";
import { SearchTool } from "@/presentation/mcp/tools/search";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { UpdateTool } from "@/presentation/mcp/tools/update";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup } from "@test/helpers";

function tools() {
  return {
    write: container.resolve(WriteTool),
    update: container.resolve(UpdateTool),
    get: container.resolve(GetTool),
    invalidate: container.resolve(InvalidateTool),
    restore: container.resolve(RestoreTool),
    search: container.resolve(SearchTool),
  };
}

async function session(): Promise<string> {
  return (await container.resolve(SessionStartTool).invoke({})).session_id;
}

async function writeFact(s: string, title: string, content?: string): Promise<string> {
  const out = (await container.resolve(WriteTool).invoke({
    session_id: s,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title,
    content: content ?? `a durable fact about ${title} with a body of a few words`,
  })) as { id: string };
  return out.id;
}

describe("RestoreTool", () => {
  it("should bring a superseded node back and retire the supersedes edge", async () => {
    // Given
    const env = setup();
    const t = tools();
    const s = await session();
    const wronglyRetired = await writeFact(s, "living index");
    const replacement = await writeFact(s, "lossy summary");
    await t.invalidate.invoke({
      session_id: s,
      id: wronglyRetired,
      reason: "merged",
      superseded_by: replacement,
    });

    // When
    const out = (await t.restore.invoke({
      session_id: s,
      id: wronglyRetired,
      reason: "the merge swallowed a hand-maintained index",
    })) as Envelope;

    // Then
    expect(out.invalidated).toBe(false);
    const live = env.db
      .prepare(
        "SELECT COUNT(*) AS c FROM edges WHERE dst = ? AND type = ? AND invalidated_at IS NULL",
      )
      .get(wronglyRetired, EdgeType.SUPERSEDES) as { c: number };
    expect(live.c).toBe(0);
  });

  it("should keep the id, the revision history and the edges it had", async () => {
    // Given
    const env = setup();
    const t = tools();
    const s = await session();
    const id = await writeFact(s, "index", "the first body of the living index");
    await t.update.invoke({
      session_id: s,
      id,
      content: "the second body of the living index",
      reason: "revised",
    });
    const referrer = await writeFact(s, "referrer");
    env.edges.insertEdge(referrer, id, EdgeType.REFERENCES, "agent", s, env.clock.t);
    await t.invalidate.invoke({ session_id: s, id, reason: "retired in error" });

    // When
    await t.restore.invoke({ session_id: s, id, reason: "it was not stale after all" });

    // Then
    const full = (
      (await t.get.invoke({ session_id: s, ids: [id], include_revisions: true })) as {
        nodes: { id: string; content: string; revisions: unknown[] }[];
      }
    ).nodes[0]!;
    expect(full.id).toBe(id);
    expect(full.content).toBe("the second body of the living index");
    expect(full.revisions).toHaveLength(2);
    expect(
      env.db
        .prepare("SELECT invalidated_at FROM edges WHERE src = ? AND dst = ?")
        .get(referrer, id),
    ).toEqual({ invalidated_at: null });
  });

  it("should make the node findable again through normal search", async () => {
    // Given
    const t = tools();
    const s = await session();
    const id = await writeFact(s, "quarantine", "a fact about quarantine procedures on ships");
    await t.invalidate.invoke({ session_id: s, id, reason: "retired in error" });
    const hidden = (await t.search.invoke({ session_id: s, query: "quarantine", limit: 10 })) as {
      results: { id: string }[];
    };
    expect(hidden.results.map((r) => r.id)).not.toContain(id);

    // When
    await t.restore.invoke({ session_id: s, id, reason: "wrong call" });

    // Then
    const found = (await t.search.invoke({ session_id: s, query: "quarantine", limit: 10 })) as {
      results: { id: string }[];
    };
    expect(found.results.map((r) => r.id)).toContain(id);
  });

  it("should leave referrers on the successor, since they have pointed there since", async () => {
    // Given
    const env = setup();
    const t = tools();
    const s = await session();
    const referrer = await writeFact(s, "referrer");
    const doomed = await writeFact(s, "doomed");
    const successor = await writeFact(s, "successor");
    env.edges.insertEdge(referrer, doomed, EdgeType.REFERENCES, "agent", s, env.clock.t);
    await t.invalidate.invoke({
      session_id: s,
      id: doomed,
      reason: "replaced",
      superseded_by: successor,
    });

    // When
    await t.restore.invoke({ session_id: s, id: doomed, reason: "wrong call" });

    // Then
    const edges = env.db
      .prepare("SELECT src, dst, type FROM edges WHERE invalidated_at IS NULL ORDER BY dst")
      .all() as { src: string; dst: string; type: string }[];
    expect(edges).toEqual([{ src: referrer, dst: successor, type: EdgeType.REFERENCES }]);
  });

  it("should refuse a node that is not invalidated", async () => {
    // Given
    const t = tools();
    const s = await session();
    const id = await writeFact(s, "alive");

    // When / Then
    await expect(t.restore.invoke({ session_id: s, id, reason: "no reason" })).rejects.toThrow(
      /not invalidated/,
    );
  });

  it("should refuse a node that does not exist", async () => {
    // Given
    const t = tools();
    const s = await session();

    // When / Then
    await expect(
      t.restore.invoke({ session_id: s, id: "01NOSUCHNODE", reason: "no reason" }),
    ).rejects.toThrow(/does not exist/);
  });
});
