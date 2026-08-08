import { createRequire } from "node:module";
import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { EdgeType, MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup } from "@test/helpers";

const require = createRequire(import.meta.url);
const { up } = require("../src/db/migrations/017_retire_stale_similarities.cjs") as {
  up: (db: import("better-sqlite3").Database) => void;
};

async function writeFact(sessionId: string, title: string): Promise<string> {
  const result = (await container.resolve(WriteTool).invoke({
    session_id: sessionId,
    parent_node_id: null,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title,
    content: `${title} has durable content for this migration fixture.`,
  })) as { id: string };

  return result.id;
}

describe("Migration 017: retire stale similarities", () => {
  it("should retire system similarities with either endpoint invalidated", async () => {
    const env = setup();
    const sessionId = (await container.resolve(SessionStartTool).invoke({})).session_id;
    const liveA = await writeFact(sessionId, "live a");
    const liveB = await writeFact(sessionId, "live b");
    const deadA = await writeFact(sessionId, "dead a");
    const deadB = await writeFact(sessionId, "dead b");
    env.nodes.invalidateNode(deadA, { ts: env.clock.t, session_id: sessionId });
    env.nodes.invalidateNode(deadB, { ts: env.clock.t, session_id: sessionId });
    env.edges.insertEdge(liveA, deadA, EdgeType.SIMILAR_TO, "system", sessionId, env.clock.t);
    env.edges.insertEdge(deadA, liveB, EdgeType.SIMILAR_TO, "system", sessionId, env.clock.t);
    env.edges.insertEdge(deadA, deadB, EdgeType.SIMILAR_TO, "system", sessionId, env.clock.t);
    env.edges.insertEdge(liveA, liveB, EdgeType.SIMILAR_TO, "system", sessionId, env.clock.t);
    env.edges.insertEdge(liveB, deadB, EdgeType.SIMILAR_TO, "agent", sessionId, env.clock.t);

    up(env.db);

    const liveEdges = env.db
      .prepare(
        "SELECT src, dst, provenance FROM edges WHERE type = ? AND invalidated_at IS NULL ORDER BY src, dst",
      )
      .all(EdgeType.SIMILAR_TO);
    expect(liveEdges).toStrictEqual([
      { src: liveA, dst: liveB, provenance: "system" },
      { src: liveB, dst: deadB, provenance: "agent" },
    ]);
  });

  it("should be idempotent", async () => {
    const env = setup();
    const sessionId = (await container.resolve(SessionStartTool).invoke({})).session_id;
    const live = await writeFact(sessionId, "live");
    const dead = await writeFact(sessionId, "dead");
    env.nodes.invalidateNode(dead, { ts: env.clock.t, session_id: sessionId });
    env.edges.insertEdge(live, dead, EdgeType.SIMILAR_TO, "system", sessionId, env.clock.t);

    up(env.db);
    const once = env.db.prepare("SELECT * FROM edges ORDER BY src, dst, type").all();
    up(env.db);

    expect(env.db.prepare("SELECT * FROM edges ORDER BY src, dst, type").all()).toStrictEqual(once);
  });
});
