import { createRequire } from "node:module";
import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { EdgeType, MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup } from "@test/helpers";

const require = createRequire(import.meta.url);
const { up } = require("../src/db/migrations/016_repair_post_supersede_edges.cjs") as {
  up: (db: import("better-sqlite3").Database) => void;
};

async function boot() {
  const env = setup();
  const sessionId = (await container.resolve(SessionStartTool).invoke({})).session_id;

  return { env, sessionId };
}

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

function supersede(
  env: ReturnType<typeof setup>,
  sessionId: string,
  dead: string,
  successor: string,
): void {
  env.nodes.invalidateNode(dead, { ts: env.clock.t, session_id: sessionId });
  env.edges.insertEdge(successor, dead, EdgeType.SUPERSEDES, "agent", sessionId, env.clock.t);
}

describe("Migration 016: repair post-supersede edges", () => {
  it("should follow a supersession chain to its unique terminal live node", async () => {
    const { env, sessionId } = await boot();
    const referrer = await writeFact(sessionId, "referrer");
    const first = await writeFact(sessionId, "first");
    const second = await writeFact(sessionId, "second");
    const terminal = await writeFact(sessionId, "terminal");
    env.edges.insertEdge(referrer, first, EdgeType.REFERENCES, "agent", sessionId, env.clock.t);
    supersede(env, sessionId, first, second);
    supersede(env, sessionId, second, terminal);

    up(env.db);

    expect(
      env.db
        .prepare(
          "SELECT src, dst, type FROM edges WHERE src = ? AND type = ? AND invalidated_at IS NULL",
        )
        .all(referrer, EdgeType.REFERENCES),
    ).toStrictEqual([{ src: referrer, dst: terminal, type: EdgeType.REFERENCES }]);
    expect(env.stats.techStats(env.clock.t).graph.repointable_edges).toBe(0);
  });

  it("should preserve an existing live target edge when the repair collides", async () => {
    const { env, sessionId } = await boot();
    const referrer = await writeFact(sessionId, "referrer");
    const dead = await writeFact(sessionId, "dead");
    const successor = await writeFact(sessionId, "successor");
    env.edges.insertEdge(referrer, dead, EdgeType.DOCUMENTS, "agent", sessionId, env.clock.t, 0.4);
    supersede(env, sessionId, dead, successor);
    env.clock.advanceDays(1);
    env.edges.insertEdge(
      referrer,
      successor,
      EdgeType.DOCUMENTS,
      "agent",
      sessionId,
      env.clock.t,
      0.9,
    );

    up(env.db);

    expect(
      env.db
        .prepare("SELECT weight, valid_from FROM edges WHERE src = ? AND dst = ? AND type = ?")
        .get(referrer, successor, EdgeType.DOCUMENTS),
    ).toStrictEqual({ weight: 0.9, valid_from: env.clock.t });
  });

  it("should skip ambiguous successors, system edges, and edges whose source is invalidated", async () => {
    const { env, sessionId } = await boot();
    const referrer = await writeFact(sessionId, "referrer");
    const dead = await writeFact(sessionId, "dead");
    const a = await writeFact(sessionId, "a");
    const b = await writeFact(sessionId, "b");
    const invalidatedSource = await writeFact(sessionId, "invalidated source");
    env.edges.insertEdge(referrer, dead, EdgeType.REFERENCES, "agent", sessionId, env.clock.t);
    env.edges.insertEdge(referrer, dead, EdgeType.SIMILAR_TO, "system", sessionId, env.clock.t);
    env.nodes.invalidateNode(dead, { ts: env.clock.t, session_id: sessionId });
    env.edges.insertEdge(a, dead, EdgeType.SUPERSEDES, "agent", sessionId, env.clock.t);
    env.edges.insertEdge(b, dead, EdgeType.SUPERSEDES, "agent", sessionId, env.clock.t);
    env.edges.insertEdge(
      invalidatedSource,
      dead,
      EdgeType.DOCUMENTS,
      "agent",
      sessionId,
      env.clock.t,
    );
    env.nodes.invalidateNode(invalidatedSource, { ts: env.clock.t, session_id: sessionId });
    const before = env.db
      .prepare("SELECT src, dst, type, invalidated_at FROM edges ORDER BY src, dst, type")
      .all();

    up(env.db);

    expect(
      env.db
        .prepare("SELECT src, dst, type, invalidated_at FROM edges ORDER BY src, dst, type")
        .all(),
    ).toStrictEqual(before);
  });

  it("should be idempotent", async () => {
    const { env, sessionId } = await boot();
    const referrer = await writeFact(sessionId, "referrer");
    const dead = await writeFact(sessionId, "dead");
    const successor = await writeFact(sessionId, "successor");
    env.edges.insertEdge(referrer, dead, EdgeType.REFERENCES, "agent", sessionId, env.clock.t);
    supersede(env, sessionId, dead, successor);
    up(env.db);
    const once = env.db.prepare("SELECT * FROM edges ORDER BY src, dst, type").all();

    up(env.db);

    expect(env.db.prepare("SELECT * FROM edges ORDER BY src, dst, type").all()).toStrictEqual(once);
  });
});
