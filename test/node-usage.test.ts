import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type BetterSqlite3 from "better-sqlite3";
import { container } from "tsyringe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "@/db/repo";
import { newId } from "@/core/ids";
import { MemoryKind } from "@/core/vocab";
import { GetTool } from "@/presentation/mcp/tools/get";
import { SearchTool } from "@/presentation/mcp/tools/search";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { RetrievalConfig, StaticConfigSource } from "@/infrastructure/config";
import { setup, type TestEnv } from "@test/helpers";

const requireCjs = createRequire(import.meta.url);
const migration = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/db/migrations/010_node_usage.cjs",
);

let env: TestEnv;
let session: string;

function weightOf(value: string): RetrievalConfig {
  return new RetrievalConfig(new StaticConfigSource({ MEMORY_USE_WEIGHT: value }));
}

function write(title: string, content: string, kind = MemoryKind.SEMANTIC): Promise<Envelope> {
  return container.resolve(WriteTool).invoke({
    session_id: session,
    parent_node_id: null,
    memory_kind: kind,
    type: kind === MemoryKind.EPISODIC ? "event_note" : "fact",
    title,
    content,
  });
}

function get(ids: string[]) {
  return container.resolve(GetTool).invoke({ session_id: session, ids });
}

function usage(id: string): { use_count: number; last_used_at: string | null } {
  return env.db.prepare("SELECT use_count, last_used_at FROM nodes WHERE id = ?").get(id) as {
    use_count: number;
    last_used_at: string | null;
  };
}

function setUseCount(id: string, count: number): void {
  env.db.prepare("UPDATE nodes SET use_count = ? WHERE id = ?").run(count, id);
}

async function rank(query: string): Promise<string[]> {
  const res = await container.resolve(SearchTool).invoke({ session_id: session, query, limit: 10 });

  return res.results.map((r) => r.id);
}

beforeEach(async () => {
  env = setup();
  session = (await container.resolve(SessionStartTool).invoke({})).session_id;
});

afterEach(() => {
  container.register(RetrievalConfig, {
    useValue: new RetrievalConfig(new StaticConfigSource({})),
  });
});

describe("Migration 010 node usage", () => {
  it("should backfill counts and the last timestamp from get events that carry ids", async () => {
    // Given
    const node = await write("Retry budget", "the http client retries with backoff");
    const insert = env.db.prepare(
      "INSERT INTO events (id, session_id, action, node_id, detail, ts) VALUES (?, ?, 'get', ?, ?, ?)",
    );
    insert.run(
      newId(),
      session,
      node.id,
      JSON.stringify({ ids: [node.id] }),
      "2026-01-02T00:00:00.000Z",
    );
    insert.run(
      newId(),
      session,
      node.id,
      JSON.stringify({ ids: [node.id] }),
      "2026-01-05T00:00:00.000Z",
    );
    // A pre-A1 row: it logged only a count, so it carries no usable ids.
    insert.run(newId(), session, node.id, JSON.stringify({ count: 1 }), "2026-01-09T00:00:00.000Z");

    // When
    (requireCjs(migration) as { up: (db: BetterSqlite3.Database) => void }).up(env.db);

    // Then
    expect(usage(node.id)).toEqual({ use_count: 2, last_used_at: "2026-01-05T00:00:00.000Z" });
  });
});

describe("Recording node use", () => {
  it("should bump the count and stamp the timestamp for the ids a get resolved", async () => {
    // Given
    const node = await write("Retry budget", "the http client retries with backoff");

    // When
    await get([node.id]);

    // Then
    expect(usage(node.id)).toEqual({ use_count: 1, last_used_at: env.clock.t });
  });

  it("should leave an unresolvable id untouched when a get half-misses", async () => {
    // Given
    const node = await write("Retry budget", "the http client retries with backoff");

    // When
    const res = (await get([node.id, "01JJJJJJJJJJJJJJJJJJJJJJJJ"])) as { not_found?: string[] };

    // Then
    expect(res.not_found).toHaveLength(1);
    expect(usage(node.id).use_count).toBe(1);
  });

  it("should not look like an edit when a node is fetched", async () => {
    // Given
    const node = await write("Retry budget", "the http client retries with backoff");
    const before = env.db
      .prepare("SELECT MAX(rev) AS rev, MAX(ts) AS ts FROM revisions WHERE node_id = ?")
      .get(node.id);

    // When
    env.clock.advanceDays(3);
    await get([node.id]);

    // Then
    const after = env.db
      .prepare("SELECT MAX(rev) AS rev, MAX(ts) AS ts FROM revisions WHERE node_id = ?")
      .get(node.id);
    expect(after).toEqual(before);
  });

  it("should not carry usage into the envelope a search returns", async () => {
    // Given
    const node = await write("Retry budget", "the http client retries with backoff");
    await get([node.id]);

    // When
    const res = await container
      .resolve(SearchTool)
      .invoke({ session_id: session, query: "retries", limit: 5 });

    // Then
    const envelope = res.results.find((r) => r.id === node.id)!;
    expect(envelope).not.toHaveProperty("use_count");
    expect(envelope).not.toHaveProperty("last_used_at");
  });
});

describe("Usage in ranking", () => {
  it("should rank a recently used episodic above an equally old unused one", async () => {
    // Given
    const topic = "deployment rollback procedure for the api gateway";
    const unused = await write("Rollback notes one", topic, MemoryKind.EPISODIC);
    const used = await write("Rollback notes two", topic, MemoryKind.EPISODIC);
    await env.worker.tick();

    // When
    env.clock.advanceDays(25);
    await get([used.id]); // decay clock restarts here for `used` only
    env.clock.advanceDays(5);

    // Then
    const ranked = await rank("deployment rollback procedure");
    expect(ranked.indexOf(used.id)).toBeLessThan(ranked.indexOf(unused.id));
  });

  it("should rank a frequently fetched semantic node above an identical unused one", async () => {
    // Given
    const topic = "the http client retries three times with exponential backoff";
    const unused = await write("Retry budget", topic);
    const used = await write("Client retries", topic);
    await env.worker.tick();
    setUseCount(used.id, 10);

    // When
    const ranked = await rank("http client retries");

    // Then
    expect(ranked.indexOf(used.id)).toBeLessThan(ranked.indexOf(unused.id));
  });

  it("should treat runaway usage the same as saturated usage", async () => {
    // Given
    const topic = "the http client retries three times with exponential backoff";
    const saturated = await write("Retry budget", topic);
    const runaway = await write("Client retries", topic);
    await env.worker.tick();
    setUseCount(saturated.id, 20);
    setUseCount(runaway.id, 1000);

    // When
    const ranked = await rank("http client retries");

    // Then
    // Both sit at the ceiling, so the pre-existing tie-break decides — not the count.
    expect(ranked.slice(0, 2).sort()).toEqual([saturated.id, runaway.id].sort());
    expect(ranked[0]).toBe([saturated.id, runaway.id].sort((a, b) => b.localeCompare(a))[0]);
  });

  it("should ignore usage entirely when the weight is zero", async () => {
    // Given
    const topic = "the http client retries three times with exponential backoff";
    const plain = await write("Retry budget", topic);
    const hot = await write("Client retries", topic);
    await env.worker.tick();
    container.register(RetrievalConfig, { useValue: weightOf("0") });

    // When
    const before = await rank("http client retries");
    setUseCount(hot.id, 1000);
    const after = await rank("http client retries");

    // Then
    expect(after).toEqual(before);
    expect(after).toContain(plain.id);
  });
});
