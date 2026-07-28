import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import type { Envelope } from "@/db/repo";
import { isBusy, withBusyRetry } from "@/db/retry";
import { EmbeddingWorker } from "@/embeddings/worker";
import { MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/tools/session-start";
import { WriteTool } from "@/tools/write";
import { setup } from "@test/helpers";

async function session(): Promise<string> {
  return (await container.resolve(SessionStartTool).invoke({})).session_id;
}
async function writeFact(s: string, title: string): Promise<Envelope> {
  return container.resolve(WriteTool).invoke({
    session_id: s,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title,
    content: `a durable fact about ${title} with a few words of body text`,
  });
}

const busyErr = () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

describe("Busy-retry wrapper", () => {
  it("should recognize the busy family and nothing else", () => {
    // Given / When / Then
    expect(isBusy(busyErr())).toBe(true);
    expect(isBusy(Object.assign(new Error("x"), { code: "SQLITE_BUSY_SNAPSHOT" }))).toBe(true);
    expect(isBusy(new Error("plain"))).toBe(false);
  });

  it("should retry a busy transaction then succeed", () => {
    // Given
    let n = 0;

    // When
    const r = withBusyRetry(
      () => {
        if (n++ < 2) throw busyErr();
        return "ok";
      },
      6,
      1,
    );

    // Then
    expect(r).toBe("ok");
    expect(n).toBe(3);
  });

  it("should rethrow a non-busy error immediately without retrying", () => {
    // Given
    let n = 0;

    // When / Then
    expect(() =>
      withBusyRetry(() => {
        n++;
        throw new Error("nope");
      }),
    ).toThrow("nope");
    expect(n).toBe(1);
  });

  it("should give up after the attempt budget on persistent busy", () => {
    // Given
    let n = 0;

    // When / Then
    expect(() =>
      withBusyRetry(
        () => {
          n++;
          throw busyErr();
        },
        3,
        1,
      ),
    ).toThrow(/locked/);
    expect(n).toBe(3);
  });
});

describe("Embedding worker lease", () => {
  it("should let only the lease holder drain while a second worker stands down", async () => {
    // Given
    const env = setup();
    const s = await session();
    await writeFact(s, "one");
    await writeFact(s, "two");
    expect(env.queue.embeddingStats().backlog).toBe(2);

    // One-chunk batches so the first tick leaves work behind for the contention check.
    const a = new EmbeddingWorker(env.queue, env.provider, env.clock, {
      batchSize: 1,
      leaseTtlMs: 10_000,
    });
    const b = new EmbeddingWorker(env.queue, env.provider, env.clock, {
      batchSize: 16,
      leaseTtlMs: 10_000,
    });

    // When / Then — A takes the lease and drains one chunk.
    expect((await a.tick()).embedded).toBeGreaterThan(0);
    const afterA = env.queue.embeddingStats().backlog;
    expect(afterA).toBeGreaterThan(0); // work remains

    // When / Then — B cannot drain: A's lease is still live at the same clock instant.
    expect((await b.tick()).embedded).toBe(0);
    expect(env.queue.embeddingStats().backlog).toBe(afterA);

    // When / Then — once A's lease lapses, B steals it and finishes the queue.
    env.clock.advanceMs(11_000);
    expect((await b.tick()).embedded).toBeGreaterThan(0);
    expect(env.queue.embeddingStats().backlog).toBe(0);
  });

  it("should keep renewing its own lease across ticks", async () => {
    // Given
    const env = setup();
    const s = await session();
    await writeFact(s, "solo");

    // When / Then
    const w = new EmbeddingWorker(env.queue, env.provider, env.clock, { leaseTtlMs: 5_000 });
    expect((await w.tick()).embedded).toBeGreaterThan(0);
    await writeFact(s, "solo-2");
    env.clock.advanceMs(4_000); // within its own TTL — still the holder, no hand-off
    expect((await w.tick()).embedded).toBeGreaterThan(0);
    expect(env.queue.embeddingStats().backlog).toBe(0);
  });
});
