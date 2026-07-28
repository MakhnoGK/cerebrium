import { describe, it, expect } from "vitest";
import { container } from "tsyringe";
import { setup } from "@test/helpers";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, openDatabaseReadonly } from "@/db/database";
import { _MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "../src/tools/session-start";
import { WriteTool } from "../src/tools/write";
import { StatsTool } from "../src/tools/stats";

async function session(): Promise<string> {
  return (await container.resolve(SessionStartTool).invoke({})).session_id;
}
async function writeFact(s: string, title: string): Promise<void> {
  await container.resolve(WriteTool).invoke({
    session_id: s,
    memory_kind: _MemoryKind.SEMANTIC,
    type: "fact",
    title,
    content: `a durable fact about ${title} with a body of a few words`,
  });
}

describe("StatsRepo.techStats", () => {
  it("should count queue, content, and drain health as nodes are written and embedded", async () => {
    // Given
    const env = setup();
    const s = await session();
    await writeFact(s, "one");
    await writeFact(s, "two");

    // When / Then — before draining.
    const before = env.stats.techStats(env.clock.t);
    expect(before.content.nodes_by_kind.semantic).toBe(2);
    expect(before.content.nodes_total).toBe(2);
    expect(before.queue.backlog).toBe(2);
    expect(before.queue.total).toBe(2);
    expect(before.content.chunks_embedded).toBe(0);
    expect(before.storage.db_bytes).toBeGreaterThan(0);

    // When / Then — after draining.
    await env.worker.tick();
    const after = env.stats.techStats(env.clock.t);
    expect(after.queue.backlog).toBe(0);
    expect(after.content.chunks_embedded).toBeGreaterThan(0);
    expect(after.content.chunks_unembedded).toBe(0);
  });

  it("should report the embedding lease as active while a worker holds it and lapsed later", async () => {
    // Given
    const env = setup();
    const s = await session();
    await writeFact(s, "held");
    await env.worker.tick(); // acquires the 'embedding' lease

    // When / Then
    const snap = env.stats.techStats(env.clock.t);
    expect(snap.drain.lease_owner).toBeTruthy();
    expect(snap.drain.lease_active).toBe(true);

    // Far in the future, the same lease has lapsed.
    const later = new Date(Date.parse(env.clock.t) + 10 * 60_000).toISOString();
    expect(env.stats.techStats(later).drain.lease_active).toBe(false);
  });
});

describe("StatsTool", () => {
  it("should return the snapshot and augment drain with provider info when called", async () => {
    // Given
    setup();
    const s = await session();
    await writeFact(s, "x");

    // When
    const out = (await container.resolve(StatsTool).invoke({ session_id: s })) as Record<
      string,
      any
    >;

    // Then
    expect(out.queue.backlog).toBe(1);
    expect(out.drain.provider).toBe("local-null@1");
    expect(out.drain).toHaveProperty("daemon_alive");
    // NOTE: event-log assertions are deferred until the DI logger lands (logging is a TODO).
  });

  it("should work without a session_id when peeked read-only", async () => {
    // Given
    setup();

    // When
    const out = (await container.resolve(StatsTool).invoke({})) as Record<string, any>;

    // Then
    expect(out.queue.total).toBe(0);
  });
});

describe("Read-only inspection handle", () => {
  it("should be unable to write, holding the single-writer invariant for the CLI", () => {
    // Given
    const dbPath = join(tmpdir(), `mk-stats-${process.pid}.db`);
    try {
      openDatabase(dbPath).close(); // create + migrate a file-backed DB
      const ro = openDatabaseReadonly(dbPath);

      // When / Then
      expect(() =>
        ro
          .prepare(
            "INSERT INTO sessions (id, project, started_at, last_seen) VALUES ('a',NULL,'t','t')",
          )
          .run(),
      ).toThrow();
      ro.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });
});
