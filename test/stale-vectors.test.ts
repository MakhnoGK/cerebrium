import { createRequire } from "node:module";
import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import type { Envelope } from "@/db/repo";
import { MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { UpdateTool } from "@/presentation/mcp/tools/update";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup, TestEnv } from "@test/helpers";

const require = createRequire(import.meta.url);
const { up } = require("../src/db/migrations/014_purge_stale_chunk_vectors.cjs") as {
  up: (db: import("better-sqlite3").Database) => void;
};

const LONG = Array.from({ length: 12 }, (_, i) => `## Heading ${i}\n${"body text ".repeat(60)}`);

async function session(): Promise<string> {
  return (await container.resolve(SessionStartTool).invoke({})).session_id;
}

async function writeLong(s: string): Promise<Envelope> {
  return container.resolve(WriteTool).invoke({
    session_id: s,
    parent_node_id: null,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title: "A node with many chunks",
    content: LONG.join("\n\n"),
  });
}

async function drain(env: TestEnv): Promise<void> {
  for (let i = 0; i < 50 && env.queue.embeddingStats().backlog > 0; i++) {
    await env.worker.tick();
  }
}

function staleWithVectors(env: TestEnv): number {
  return (
    env.db
      .prepare(
        `SELECT COUNT(*) AS c FROM chunks c
         JOIN chunk_vec v ON v.chunk_id = c.id WHERE c.stale = 1`,
      )
      .get() as { c: number }
  ).c;
}

function staleChunks(env: TestEnv): number {
  return (env.db.prepare("SELECT COUNT(*) AS c FROM chunks WHERE stale = 1").get() as { c: number })
    .c;
}

describe("Stale chunk vectors", () => {
  it("should drop the vector and its provenance when a revision supersedes a chunk", async () => {
    // Given
    const env = setup();
    const s = await session();
    const node = await writeLong(s);
    await drain(env);
    expect(staleChunks(env)).toBe(0);

    // When
    await container.resolve(UpdateTool).invoke({
      session_id: s,
      id: node.id,
      content: "a much shorter body that keeps none of the old chunks",
    });
    await drain(env);

    // Then
    expect(staleChunks(env)).toBeGreaterThan(0);
    expect(staleWithVectors(env)).toBe(0);
    const orphanMeta = env.db
      .prepare(
        `SELECT COUNT(*) AS c FROM embedding_meta m
         JOIN chunks c ON c.id = m.chunk_id WHERE c.stale = 1`,
      )
      .get() as { c: number };
    expect(orphanMeta.c).toBe(0);
  });

  it("should keep the node's live chunks embedded when its stale ones are dropped", async () => {
    // Given
    const env = setup();
    const s = await session();
    const node = await writeLong(s);
    await drain(env);

    // When
    await container.resolve(UpdateTool).invoke({
      session_id: s,
      id: node.id,
      content: `${LONG[0]!}\n\n## A new heading\n${"different words ".repeat(60)}`,
    });
    await drain(env);

    // Then
    const live = env.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(v.chunk_id IS NOT NULL) AS embedded FROM chunks c
         LEFT JOIN chunk_vec v ON v.chunk_id = c.id WHERE c.node_id = ? AND c.stale = 0`,
      )
      .get(node.id) as { total: number; embedded: number };
    expect(live.total).toBeGreaterThan(0);
    expect(live.embedded).toBe(live.total);
  });

  it("should re-embed a chunk that a later revision brings back", async () => {
    // Given
    const env = setup();
    const s = await session();
    const node = await writeLong(s);
    await drain(env);
    const update = container.resolve(UpdateTool);
    await update.invoke({ session_id: s, id: node.id, content: "an unrelated short body" });
    await drain(env);

    // When — the original text returns, reviving the content-addressed chunk ids.
    await update.invoke({ session_id: s, id: node.id, content: LONG.join("\n\n") });
    await drain(env);

    // Then
    const live = env.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(v.chunk_id IS NOT NULL) AS embedded FROM chunks c
         LEFT JOIN chunk_vec v ON v.chunk_id = c.id WHERE c.node_id = ? AND c.stale = 0`,
      )
      .get(node.id) as { total: number; embedded: number };
    expect(live.embedded).toBe(live.total);
  });
});

describe("Migration 014: purge stale chunk vectors", () => {
  it("should clear the backlog a pre-014 store accumulated when it is migrated", async () => {
    // Given — the old behaviour: chunks go stale, their vectors stay.
    const env = setup();
    const s = await session();
    const node = await writeLong(s);
    await drain(env);
    const before = env.db.prepare("SELECT id, text FROM chunks WHERE node_id = ?").all(node.id) as {
      id: string;
      text: string;
    }[];
    await container.resolve(UpdateTool).invoke({
      session_id: s,
      id: node.id,
      content: "a much shorter body that keeps none of the old chunks",
    });
    await drain(env);
    const revive = env.db.prepare(
      "INSERT OR REPLACE INTO chunk_vec (chunk_id, embedding) VALUES (?, vec_f32(?))",
    );
    for (const row of before) revive.run(row.id, JSON.stringify(Array(384).fill(0.1)));
    expect(staleWithVectors(env)).toBeGreaterThan(0);

    // When
    up(env.db);

    // Then
    expect(staleWithVectors(env)).toBe(0);
    expect(staleChunks(env)).toBeGreaterThan(0);
  });
});
