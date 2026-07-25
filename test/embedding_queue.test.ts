import { describe, it, expect } from "vitest";
import { makeCtx } from "@test/helpers";
import { EmbeddingWorker } from "@/embeddings/worker";
import type { EmbeddingProvider } from "@/embeddings/index";
import type { Ctx } from "@/tools/context";
import type { Envelope } from "@/db/repo";
import { SessionStartTool } from "../src/tools/session_start";
import { WriteTool } from "../src/tools/write";

const session_start = new SessionStartTool();
const write = new WriteTool();

async function session(ctx: Ctx): Promise<string> {
  return (await session_start.invoke(ctx, {})).session_id;
}

async function writeFact(ctx: Ctx, s: string, title: string): Promise<Envelope> {
  return await write.invoke(ctx, {
    session_id: s,
    memory_kind: "semantic",
    type: "fact",
    title,
    content: `a durable fact about ${title} with a few words of body text`,
  });
}

// Always-throwing provider (dim matches so the ctx builds) to drive retry/backoff.
class BrokenProvider implements EmbeddingProvider {
  readonly name = "broken";
  readonly version = "0";
  readonly dim = 384;
  async embed(): Promise<number[][]> {
    throw new Error("provider down");
  }
}

describe("embedding queue drains", () => {
  it("moves a node from pending -> embedded on tick", async () => {
    const { ctx, repo, worker, db } = makeCtx();
    const s = await session(ctx);
    const node = await writeFact(ctx, s, "TTL");

    expect(
      (db.prepare("SELECT pending_embedding p FROM nodes WHERE id=?").get(node.id) as { p: number })
        .p,
    ).toBe(1);
    expect(repo.embeddingStats().backlog).toBe(1);

    const res = await worker.tick();
    expect(res.embedded).toBeGreaterThan(0);
    expect(
      (db.prepare("SELECT pending_embedding p FROM nodes WHERE id=?").get(node.id) as { p: number })
        .p,
    ).toBe(0);
    expect(repo.embeddingStats().backlog).toBe(0);
    expect(db.prepare("SELECT COUNT(*) c FROM embedding_queue").get()).toEqual({ c: 0 });
  });
});

describe("retry with backoff, then park", () => {
  it("increments attempts, honors backoff, and parks after 5 failures", async () => {
    const { ctx, repo, clock } = makeCtx({ provider: new BrokenProvider() });
    const worker = new EmbeddingWorker(repo, new BrokenProvider(), () => clock.t, {
      backoffBaseMs: 1000,
    });
    const s = await session(ctx);
    await writeFact(ctx, s, "Flaky");

    await worker.tick(); // attempt 1 fails
    expect(repo.queueRows(10)[0]!.attempts).toBe(1);

    // backoff: not eligible again until the clock advances past base * 2^(n-1)
    await worker.tick();
    expect(repo.queueRows(10)[0]!.attempts).toBe(1); // skipped, no retry yet

    for (let n = 2; n <= 5; n++) {
      clock.advanceMs(60_000); // past any backoff
      await worker.tick();
      if (n < 5) expect(repo.queueRows(10)[0]!.attempts).toBe(n);
    }

    // attempts === 5 -> parked, excluded from the eligible queue
    expect(repo.queueRows(10).length).toBe(0);
    expect(repo.embeddingStats().parked).toBe(1);
    expect(repo.embeddingStats().backlog).toBe(0);

    clock.advanceMs(10_000_000);
    expect((await worker.tick()).embedded).toBe(0); // stays parked, no retry
  });
});

describe("restart recovery", () => {
  it("a fresh worker drains a queue that survived the previous process", async () => {
    const { ctx, repo, provider, clock } = makeCtx();
    const s = await session(ctx);
    const node = await writeFact(ctx, s, "Survivor"); // enqueued, never drained

    const restarted = new EmbeddingWorker(repo, provider, () => clock.t);
    restarted.reconcile();
    expect((await restarted.tick()).embedded).toBeGreaterThan(0);
    expect(repo.embeddingStats().backlog).toBe(0);
    void node;
  });

  it("re-enqueues a pending node whose queue row was lost", async () => {
    const { ctx, repo, provider, clock, db } = makeCtx();
    const s = await session(ctx);
    const node = await writeFact(ctx, s, "Orphan");

    db.prepare("DELETE FROM embedding_queue").run(); // simulate a lost queue row
    expect(repo.queueRows(10).length).toBe(0);

    const restarted = new EmbeddingWorker(repo, provider, () => clock.t);
    restarted.reconcile();
    expect(repo.queueRows(10).length).toBe(1); // pending node re-queued

    await restarted.tick();
    expect(
      (db.prepare("SELECT pending_embedding p FROM nodes WHERE id=?").get(node.id) as { p: number })
        .p,
    ).toBe(0);
  });
});
