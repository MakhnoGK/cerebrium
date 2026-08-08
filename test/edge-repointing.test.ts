import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { EdgeType, MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup } from "@test/helpers";

async function session(): Promise<string> {
  return (await container.resolve(SessionStartTool).invoke({})).session_id;
}

async function writeFact(s: string, title: string): Promise<string> {
  const out = (await container.resolve(WriteTool).invoke({
    session_id: s,
    parent_node_id: null,
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

describe("NodesRepo.invalidateNode edge re-pointing", () => {
  it("should move a referrer onto the successor when a node is superseded", async () => {
    // Given
    const env = setup();
    const s = await session();
    const referrer = await writeFact(s, "referrer");
    const doomed = await writeFact(s, "doomed");
    const successor = await writeFact(s, "successor");
    env.edges.insertEdge(referrer, doomed, EdgeType.REFERENCES, "agent", s, env.clock.t);

    // When
    env.nodes.invalidateNode(doomed, {
      ts: env.clock.t,
      superseded_by: successor,
      session_id: s,
    });

    // Then
    const edges = liveEdges(env.db);
    expect(edges).toContainEqual({ src: referrer, dst: successor, type: EdgeType.REFERENCES });
    expect(edges).not.toContainEqual({ src: referrer, dst: doomed, type: EdgeType.REFERENCES });
    expect(env.stats.techStats(env.clock.t).graph.dangling_edges).toBe(0);
  });

  it("should drop the edge rather than create a self-loop when the referrer is the successor", async () => {
    // Given
    const env = setup();
    const s = await session();
    const doomed = await writeFact(s, "doomed");
    const successor = await writeFact(s, "successor");
    env.edges.insertEdge(successor, doomed, EdgeType.REFERENCES, "agent", s, env.clock.t);

    // When
    env.nodes.invalidateNode(doomed, {
      ts: env.clock.t,
      superseded_by: successor,
      session_id: s,
    });

    // Then
    const edges = liveEdges(env.db);
    expect(edges).not.toContainEqual({ src: successor, dst: successor, type: EdgeType.REFERENCES });
    expect(edges).toEqual([{ src: successor, dst: doomed, type: EdgeType.SUPERSEDES }]);
  });

  it("should leave a system edge where it is, since the sweep recomputes those", async () => {
    // Given
    const env = setup();
    const s = await session();
    const referrer = await writeFact(s, "referrer");
    const doomed = await writeFact(s, "doomed");
    const successor = await writeFact(s, "successor");
    env.edges.insertEdge(referrer, doomed, EdgeType.SIMILAR_TO, "system", s, env.clock.t);

    // When
    env.nodes.invalidateNode(doomed, {
      ts: env.clock.t,
      superseded_by: successor,
      session_id: s,
    });

    // Then
    const edges = liveEdges(env.db);
    expect(edges).toContainEqual({ src: referrer, dst: doomed, type: EdgeType.SIMILAR_TO });
    expect(edges).not.toContainEqual({ src: referrer, dst: successor, type: EdgeType.SIMILAR_TO });
  });

  it("should leave referrers alone when no successor is named", async () => {
    // Given
    const env = setup();
    const s = await session();
    const referrer = await writeFact(s, "referrer");
    const doomed = await writeFact(s, "doomed");
    env.edges.insertEdge(referrer, doomed, EdgeType.REFERENCES, "agent", s, env.clock.t);

    // When
    env.nodes.invalidateNode(doomed, { ts: env.clock.t, session_id: s });

    // Then
    expect(liveEdges(env.db)).toContainEqual({
      src: referrer,
      dst: doomed,
      type: EdgeType.REFERENCES,
    });
  });

  it("should keep a referrer in the graph whose only anchor was superseded", async () => {
    // Given — `island` hangs off `doomed` alone.
    const env = setup();
    const s = await session();
    const hub = await writeFact(s, "hub");
    const spoke = await writeFact(s, "spoke");
    const doomed = await writeFact(s, "doomed");
    const island = await writeFact(s, "island");
    env.edges.insertEdge(hub, spoke, EdgeType.REFERENCES, "agent", s, env.clock.t);
    env.edges.insertEdge(hub, doomed, EdgeType.REFERENCES, "agent", s, env.clock.t);
    env.edges.insertEdge(island, doomed, EdgeType.REFERENCES, "agent", s, env.clock.t);

    // When
    env.nodes.invalidateNode(doomed, { ts: env.clock.t, superseded_by: hub, session_id: s });

    // Then
    expect(env.stats.techStats(env.clock.t).graph.detached_nodes).toBe(0);
  });

  it("should be a no-op on the merge path, which re-points before it invalidates", async () => {
    // Given
    const env = setup();
    const s = await session();
    const referrer = await writeFact(s, "referrer");
    const loser = await writeFact(s, "loser");
    const survivor = await writeFact(s, "survivor");
    env.edges.insertEdge(referrer, loser, EdgeType.REFERENCES, "agent", s, env.clock.t);

    // When
    env.nodes.applyMerge({
      survivorId: survivor,
      loserId: loser,
      session_id: s,
      ts: env.clock.t,
    });

    // Then
    const edges = liveEdges(env.db);
    expect(edges).toEqual([
      { src: referrer, dst: survivor, type: EdgeType.REFERENCES },
      { src: survivor, dst: loser, type: EdgeType.SUPERSEDES },
    ]);
  });

  it("should not re-point a second time when an already-invalidated node is invalidated again", async () => {
    // Given
    const env = setup();
    const s = await session();
    const referrer = await writeFact(s, "referrer");
    const doomed = await writeFact(s, "doomed");
    const first = await writeFact(s, "first successor");
    const second = await writeFact(s, "second successor");
    env.edges.insertEdge(referrer, doomed, EdgeType.REFERENCES, "agent", s, env.clock.t);
    env.nodes.invalidateNode(doomed, { ts: env.clock.t, superseded_by: first, session_id: s });

    // When
    env.nodes.invalidateNode(doomed, { ts: env.clock.t, superseded_by: second, session_id: s });

    // Then
    const edges = liveEdges(env.db);
    expect(edges).toContainEqual({ src: referrer, dst: first, type: EdgeType.REFERENCES });
    expect(edges).not.toContainEqual({ src: referrer, dst: second, type: EdgeType.REFERENCES });
  });
});
