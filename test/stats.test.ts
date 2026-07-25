import { describe, it, expect } from "vitest";
import { makeCtx } from "./helpers";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, openDatabaseReadonly } from "@/db/database";
import type { Ctx } from "@/tools/context";
import { SessionStartTool } from "../src/tools/session_start";
import { WriteTool } from "../src/tools/write";
import { StatsTool } from "../src/tools/stats";

const session_start = new SessionStartTool();
const write = new WriteTool();
const stats = new StatsTool();

async function session(ctx: Ctx): Promise<string> {
  return (await session_start.invoke(ctx, {})).session_id;
}
async function writeFact(ctx: Ctx, s: string, title: string): Promise<void> {
  await write.invoke(ctx, {
    session_id: s,
    memory_kind: "semantic",
    type: "fact",
    title,
    content: `a durable fact about ${title} with a body of a few words`,
  });
}

describe("techStats", () => {
  it("counts queue, content, and drain health", async () => {
    const { ctx, repo, worker, clock } = makeCtx();
    const s = await session(ctx);
    await writeFact(ctx, s, "one");
    await writeFact(ctx, s, "two");

    const before = repo.techStats(clock.t);
    expect(before.content.nodes_by_kind.semantic).toBe(2);
    expect(before.content.nodes_total).toBe(2);
    expect(before.queue.backlog).toBe(2);
    expect(before.queue.total).toBe(2);
    expect(before.content.chunks_embedded).toBe(0);
    expect(before.storage.db_bytes).toBeGreaterThan(0);

    await worker.tick();
    const after = repo.techStats(clock.t);
    expect(after.queue.backlog).toBe(0);
    expect(after.content.chunks_embedded).toBeGreaterThan(0);
    expect(after.content.chunks_unembedded).toBe(0);
  });

  it("reports the embedding lease as active while a worker holds it", async () => {
    const { ctx, repo, worker, clock } = makeCtx();
    const s = await session(ctx);
    await writeFact(ctx, s, "held");
    await worker.tick(); // acquires the 'embedding' lease

    const snap = repo.techStats(clock.t);
    expect(snap.drain.lease_owner).toBeTruthy();
    expect(snap.drain.lease_active).toBe(true);

    // Far in the future, the same lease has lapsed.
    const later = new Date(Date.parse(clock.t) + 10 * 60_000).toISOString();
    expect(repo.techStats(later).drain.lease_active).toBe(false);
  });
});

describe("stats tool", () => {
  it("returns the snapshot, augments drain with provider, and logs a stats event", async () => {
    const { ctx, db } = makeCtx();
    const s = await session(ctx);
    await writeFact(ctx, s, "x");

    const out = (await stats.invoke(ctx, { session_id: s })) as Record<string, any>;
    expect(out.queue.backlog).toBe(1);
    expect(out.drain.provider).toBe("local-null@1");
    expect(out.drain).toHaveProperty("daemon_alive");

    const ev = db.prepare("SELECT COUNT(*) c FROM events WHERE action = 'stats'").get() as {
      c: number;
    };
    expect(ev.c).toBe(1);
  });

  it("works without a session_id and logs no event", async () => {
    const { ctx, db } = makeCtx();
    const out = (await stats.invoke(ctx, {})) as Record<string, any>;
    expect(out.queue.total).toBe(0);
    const ev = db.prepare("SELECT COUNT(*) c FROM events WHERE action = 'stats'").get() as {
      c: number;
    };
    expect(ev.c).toBe(0);
  });
});

describe("read-only inspection handle", () => {
  it("cannot write (single-writer invariant holds for the CLI)", () => {
    const dbPath = join(tmpdir(), `mk-stats-${process.pid}.db`);
    try {
      openDatabase(dbPath).close(); // create + migrate a file-backed DB
      const ro = openDatabaseReadonly(dbPath);
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
