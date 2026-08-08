import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import type { ExtractedSymbol, FileIndexInput } from "@/db/repo";
import { MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup, TestEnv } from "@test/helpers";

const require = createRequire(import.meta.url);
const { up } = require("../src/db/migrations/013_split_vector_pools.cjs") as {
  up: (db: import("better-sqlite3").Database) => void;
};

const REPO = "demo";
const PATH = "auth/auth.service.ts";
const TS = "2026-01-01T00:00:00.000Z";

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 24);
}

function fileInput(names: string[]): FileIndexInput {
  const symbols: ExtractedSymbol[] = names.map((name) => {
    const qualified = `${PATH}:${name}`;
    return {
      external_id: hash(`${REPO}\0${PATH}\0${qualified}\0function`),
      symbol_kind: "function",
      name,
      qualified,
      signature: `function ${name}()`,
      summary: `function ${name}() indexed from the demo repository`,
      start_line: 1,
      end_line: 2,
      code_hash: hash(name),
      source: `function ${name}() {}`,
    };
  });
  return {
    repo: REPO,
    path: PATH,
    lang: "typescript",
    fileHash: hash(names.join("|")),
    defines: [],
    session_id: "sess-1",
    ts: TS,
    symbols,
  };
}

function count(env: TestEnv, pool: "chunk_vec" | "code_vec"): number {
  return (env.db.prepare(`SELECT COUNT(*) AS c FROM ${pool}`).get() as { c: number }).c;
}

// Undoes the routing the write path now applies, so `up` has a pre-013 pool to migrate.
function merge(env: TestEnv): void {
  const rows = env.db.prepare("SELECT chunk_id, embedding FROM code_vec").all() as {
    chunk_id: string;
    embedding: Buffer;
  }[];
  const insert = env.db.prepare(
    "INSERT OR REPLACE INTO chunk_vec (chunk_id, embedding) VALUES (?, ?)",
  );
  const remove = env.db.prepare("DELETE FROM code_vec WHERE chunk_id = ?");
  for (const row of rows) {
    insert.run(row.chunk_id, row.embedding);
    remove.run(row.chunk_id);
  }
}

async function seed(env: TestEnv): Promise<void> {
  const s = (await container.resolve(SessionStartTool).invoke({})).session_id;
  await container.resolve(WriteTool).invoke({
    session_id: s,
    parent_node_id: null,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title: "Retention policy",
    content: "a durable fact about retention with a few words of body text",
  });
  env.code.applyFileIndex(fileInput(["validate", "reject"]));
  for (let i = 0; i < 50 && env.queue.embeddingStats().backlog > 0; i++) {
    await env.worker.tick();
  }
}

describe("Migration 013: split the vector pools", () => {
  it("should move code vectors out of chunk_vec and leave authored ones when a merged pool is migrated", async () => {
    // Given
    const env = setup();
    await seed(env);
    const authored = count(env, "chunk_vec");
    const code = count(env, "code_vec");
    merge(env);
    expect(count(env, "chunk_vec")).toBe(authored + code);
    expect(count(env, "code_vec")).toBe(0);

    // When
    up(env.db);

    // Then
    expect(count(env, "chunk_vec")).toBe(authored);
    expect(count(env, "code_vec")).toBe(code);
  });

  it("should be a no-op when run a second time", async () => {
    // Given
    const env = setup();
    await seed(env);
    merge(env);
    up(env.db);
    const authored = count(env, "chunk_vec");
    const code = count(env, "code_vec");

    // When
    up(env.db);

    // Then
    expect(count(env, "chunk_vec")).toBe(authored);
    expect(count(env, "code_vec")).toBe(code);
  });

  it("should keep every vector reachable in exactly one pool when a merged pool is migrated", async () => {
    // Given
    const env = setup();
    await seed(env);
    merge(env);
    const all = new Set(
      (env.db.prepare("SELECT chunk_id FROM chunk_vec").all() as { chunk_id: string }[]).map(
        (r) => r.chunk_id,
      ),
    );

    // When
    up(env.db);

    // Then
    const after = (
      env.db
        .prepare("SELECT chunk_id FROM chunk_vec UNION ALL SELECT chunk_id FROM code_vec")
        .all() as { chunk_id: string }[]
    ).map((r) => r.chunk_id);
    expect(after.length).toBe(all.size);
    expect(new Set(after)).toEqual(all);
  });
});
