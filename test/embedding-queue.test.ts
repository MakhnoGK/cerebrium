import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { EmbeddingProvider } from "@/domain/ports/embedding-provider";
import { EmbeddingWorker } from "@/application/workers";
import type { Envelope } from "@/db/repo";
import { MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup } from "@test/helpers";

async function session(): Promise<string> {
  return (await container.resolve(SessionStartTool).invoke({})).session_id;
}
async function writeFact(s: string, title: string): Promise<Envelope> {
  return container.resolve(WriteTool).invoke({
    session_id: s,
    parent_node_id: null,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title,
    content: `a durable fact about ${title} with a few words of body text`,
  });
}

// Always-throwing provider (dim matches so the DB builds) to drive retry/backoff.
class BrokenProvider implements EmbeddingProvider {
  readonly name = "broken";
  readonly version = "0";
  readonly dim = 384;
  async embed(): Promise<number[][]> {
    throw new Error("provider down");
  }
}

describe("Embedding queue drains", () => {
  it("should move a node from pending to embedded on a tick", async () => {
    // Given
    const env = setup();
    const s = await session();
    const node = await writeFact(s, "TTL");
    expect(
      (
        env.db.prepare("SELECT pending_embedding p FROM nodes WHERE id=?").get(node.id) as {
          p: number;
        }
      ).p,
    ).toBe(1);
    expect(env.queue.embeddingStats().backlog).toBe(1);

    // When
    const res = await env.worker.tick();

    // Then
    expect(res.embedded).toBeGreaterThan(0);
    expect(
      (
        env.db.prepare("SELECT pending_embedding p FROM nodes WHERE id=?").get(node.id) as {
          p: number;
        }
      ).p,
    ).toBe(0);
    expect(env.queue.embeddingStats().backlog).toBe(0);
    expect(env.db.prepare("SELECT COUNT(*) c FROM embedding_queue").get()).toEqual({ c: 0 });
  });
});

describe("Retry with backoff, then park", () => {
  it("should increment attempts, honor backoff, and park after 5 failures", async () => {
    // Given
    const env = setup();
    const worker = new EmbeddingWorker(env.queue, new BrokenProvider(), env.clock, {
      backoffBaseMs: 1000,
    });
    const s = await session();
    await writeFact(s, "Flaky");

    // When / Then — attempt 1 fails.
    await worker.tick();
    expect(env.queue.queueRows(10)[0]!.attempts).toBe(1);

    // When / Then — backoff: not eligible again until the clock advances.
    await worker.tick();
    expect(env.queue.queueRows(10)[0]!.attempts).toBe(1); // skipped, no retry yet

    for (let n = 2; n <= 5; n++) {
      env.clock.advanceMs(60_000); // past any backoff
      await worker.tick();
      if (n < 5) expect(env.queue.queueRows(10)[0]!.attempts).toBe(n);
    }

    // Then — attempts === 5 -> parked, excluded from the eligible queue.
    expect(env.queue.queueRows(10).length).toBe(0);
    expect(env.queue.embeddingStats().parked).toBe(1);
    expect(env.queue.embeddingStats().backlog).toBe(0);

    // When / Then — stays parked, no retry.
    env.clock.advanceMs(10_000_000);
    expect((await worker.tick()).embedded).toBe(0);
  });
});

describe("Restart recovery", () => {
  it("should let a fresh worker drain a queue that survived the previous process", async () => {
    // Given
    const env = setup();
    const s = await session();
    await writeFact(s, "Survivor"); // enqueued, never drained

    // When
    const restarted = new EmbeddingWorker(env.queue, env.provider, env.clock);
    restarted.reconcile();

    // Then
    expect((await restarted.tick()).embedded).toBeGreaterThan(0);
    expect(env.queue.embeddingStats().backlog).toBe(0);
  });

  it("should re-enqueue a pending node whose queue row was lost", async () => {
    // Given
    const env = setup();
    const s = await session();
    const node = await writeFact(s, "Orphan");
    env.db.prepare("DELETE FROM embedding_queue").run(); // simulate a lost queue row
    expect(env.queue.queueRows(10).length).toBe(0);

    // When
    const restarted = new EmbeddingWorker(env.queue, env.provider, env.clock);
    restarted.reconcile();

    // Then
    expect(env.queue.queueRows(10).length).toBe(1); // pending node re-queued
    await restarted.tick();
    expect(
      (
        env.db.prepare("SELECT pending_embedding p FROM nodes WHERE id=?").get(node.id) as {
          p: number;
        }
      ).p,
    ).toBe(0);
  });
});
