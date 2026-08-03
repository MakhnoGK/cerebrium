import { createRequire } from "node:module";
import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { EdgeType, MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup } from "@test/helpers";

const require = createRequire(import.meta.url);
const { up } = require("../src/db/migrations/012_repoint_dangling_edges.cjs") as {
  up: (db: import("better-sqlite3").Database) => void;
};

async function session(): Promise<string> {
  return (await container.resolve(SessionStartTool).invoke({})).session_id;
}

async function writeFact(s: string, title: string): Promise<string> {
  const out = (await container.resolve(WriteTool).invoke({
    session_id: s,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title,
    content: `a durable fact about ${title} with a body of a few words`,
  })) as { id: string };
  return out.id;
}

function liveEdges(db: { prepare: (sql: string) => { all: () => unknown } }) {
  return db
    .prepare(
      "SELECT src, dst, type FROM edges WHERE invalidated_at IS NULL ORDER BY src, dst, type",
    )
    .all() as { src: string; dst: string; type: string }[];
}

// The pre-repair shape: a node retired without the write path re-pointing anything,
// with its successor recorded separately. This is what the store looked like before
// `invalidateNode` learned to move referrers.
function strand(
  env: ReturnType<typeof setup>,
  s: string,
  dead: string,
  successors: string[],
): void {
  env.nodes.invalidateNode(dead, { ts: env.clock.t, session_id: s });
  for (const successor of successors) {
    env.edges.insertEdge(successor, dead, EdgeType.SUPERSEDES, "agent", s, env.clock.t);
  }
}

describe("Migration 012: re-point dangling edges", () => {
  it("should move a stranded authored edge onto the successor when the backlog is repaired", async () => {
    // Given
    const env = setup();
    const s = await session();
    const referrer = await writeFact(s, "referrer");
    const dead = await writeFact(s, "dead");
    const successor = await writeFact(s, "successor");
    env.edges.insertEdge(referrer, dead, EdgeType.REFERENCES, "agent", s, env.clock.t);
    strand(env, s, dead, [successor]);
    expect(env.stats.techStats(env.clock.t).graph.repointable_edges).toBe(1);

    // When
    up(env.db);

    // Then
    const edges = liveEdges(env.db);
    expect(edges).toContainEqual({ src: referrer, dst: successor, type: EdgeType.REFERENCES });
    expect(edges).not.toContainEqual({ src: referrer, dst: dead, type: EdgeType.REFERENCES });
    expect(env.stats.techStats(env.clock.t).graph.repointable_edges).toBe(0);
  });

  it("should keep the retired edge queryable rather than deleting it", async () => {
    // Given
    const env = setup();
    const s = await session();
    const referrer = await writeFact(s, "referrer");
    const dead = await writeFact(s, "dead");
    const successor = await writeFact(s, "successor");
    env.edges.insertEdge(referrer, dead, EdgeType.REFERENCES, "agent", s, env.clock.t);
    strand(env, s, dead, [successor]);

    // When
    up(env.db);

    // Then
    const retired = env.db
      .prepare("SELECT invalidated_at FROM edges WHERE src = ? AND dst = ? AND type = ?")
      .get(referrer, dead, EdgeType.REFERENCES) as { invalidated_at: string | null };
    expect(retired.invalidated_at).not.toBeNull();
  });

  it("should leave a system edge and the supersedes edge untouched", async () => {
    // Given
    const env = setup();
    const s = await session();
    const referrer = await writeFact(s, "referrer");
    const dead = await writeFact(s, "dead");
    const successor = await writeFact(s, "successor");
    env.edges.insertEdge(referrer, dead, EdgeType.SIMILAR_TO, "system", s, env.clock.t);
    strand(env, s, dead, [successor]);

    // When
    up(env.db);

    // Then
    const edges = liveEdges(env.db);
    expect(edges).toContainEqual({ src: referrer, dst: dead, type: EdgeType.SIMILAR_TO });
    expect(edges).toContainEqual({ src: successor, dst: dead, type: EdgeType.SUPERSEDES });
  });

  it("should drop the edge rather than create a self-loop when the referrer is the successor", async () => {
    // Given
    const env = setup();
    const s = await session();
    const dead = await writeFact(s, "dead");
    const successor = await writeFact(s, "successor");
    env.edges.insertEdge(successor, dead, EdgeType.REFERENCES, "agent", s, env.clock.t);
    strand(env, s, dead, [successor]);

    // When
    up(env.db);

    // Then
    expect(liveEdges(env.db)).toEqual([{ src: successor, dst: dead, type: EdgeType.SUPERSEDES }]);
  });

  it("should leave the edge in place when every successor is itself dead", async () => {
    // Given
    const env = setup();
    const s = await session();
    const referrer = await writeFact(s, "referrer");
    const dead = await writeFact(s, "dead");
    const alsoDead = await writeFact(s, "also dead");
    env.edges.insertEdge(referrer, dead, EdgeType.REFERENCES, "agent", s, env.clock.t);
    strand(env, s, dead, [alsoDead]);
    env.nodes.invalidateNode(alsoDead, { ts: env.clock.t, session_id: s });

    // When
    up(env.db);

    // Then
    expect(liveEdges(env.db)).toContainEqual({
      src: referrer,
      dst: dead,
      type: EdgeType.REFERENCES,
    });
  });

  it("should pick one successor deterministically when several are live", async () => {
    // Given
    const env = setup();
    const s = await session();
    const referrer = await writeFact(s, "referrer");
    const dead = await writeFact(s, "dead");
    const a = await writeFact(s, "successor a");
    const b = await writeFact(s, "successor b");
    env.edges.insertEdge(referrer, dead, EdgeType.REFERENCES, "agent", s, env.clock.t);
    strand(env, s, dead, [a, b]);

    // When
    up(env.db);

    // Then — same valid_from, so the higher src wins the tie-break.
    const winner = a > b ? a : b;
    expect(liveEdges(env.db)).toContainEqual({
      src: referrer,
      dst: winner,
      type: EdgeType.REFERENCES,
    });
  });

  it("should be a no-op on a store with nothing stranded", async () => {
    // Given
    const env = setup();
    const s = await session();
    const one = await writeFact(s, "one");
    const two = await writeFact(s, "two");
    env.edges.insertEdge(one, two, EdgeType.REFERENCES, "agent", s, env.clock.t);
    const before = liveEdges(env.db);

    // When
    up(env.db);

    // Then
    expect(liveEdges(env.db)).toEqual(before);
  });
});
