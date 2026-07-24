import { describe, it, expect } from "vitest";
import { makeCtx } from "./helpers";
import { withBusyRetry, isBusy } from "@/db/retry";
import { EmbeddingWorker } from "@/embeddings/worker";
import * as session_start from "@/tools/session_start";
import * as write from "@/tools/write";
import type { Ctx } from "@/tools/context";
import type { Envelope } from "@/db/repo";

async function session(ctx: Ctx): Promise<string> {
  return (await session_start.handler(ctx, {})).session_id;
}

async function writeFact(ctx: Ctx, s: string, title: string): Promise<Envelope> {
  return (await write.handler(ctx, {
    session_id: s,
    memory_kind: "semantic",
    type: "fact",
    title,
    content: `a durable fact about ${title} with a few words of body text`,
  })) as unknown as Envelope;
}

const busyErr = () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

describe("busy-retry wrapper", () => {
  it("recognizes the busy family and nothing else", () => {
    expect(isBusy(busyErr())).toBe(true);
    expect(isBusy(Object.assign(new Error("x"), { code: "SQLITE_BUSY_SNAPSHOT" }))).toBe(true);
    expect(isBusy(new Error("plain"))).toBe(false);
  });

  it("retries a busy transaction then succeeds", () => {
    let n = 0;
    const r = withBusyRetry(
      () => {
        if (n++ < 2) throw busyErr();
        return "ok";
      },
      6,
      1,
    );
    expect(r).toBe("ok");
    expect(n).toBe(3);
  });

  it("rethrows a non-busy error immediately without retrying", () => {
    let n = 0;
    expect(() =>
      withBusyRetry(() => {
        n++;
        throw new Error("nope");
      }),
    ).toThrow("nope");
    expect(n).toBe(1);
  });

  it("gives up after the attempt budget on persistent busy", () => {
    let n = 0;
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

describe("embedding worker lease", () => {
  it("lets only the lease holder drain while a second worker stands down", async () => {
    const { ctx, repo, provider, clock } = makeCtx();
    const s = await session(ctx);
    await writeFact(ctx, s, "one");
    await writeFact(ctx, s, "two");
    expect(repo.embeddingStats().backlog).toBe(2);

    // One-chunk batches so the first tick leaves work behind for the contention check.
    const a = new EmbeddingWorker(repo, provider, () => clock.t, {
      batchSize: 1,
      leaseTtlMs: 10_000,
    });
    const b = new EmbeddingWorker(repo, provider, () => clock.t, {
      batchSize: 16,
      leaseTtlMs: 10_000,
    });

    expect((await a.tick()).embedded).toBeGreaterThan(0); // A takes the lease
    const afterA = repo.embeddingStats().backlog;
    expect(afterA).toBeGreaterThan(0); // work remains

    // B cannot drain: A's lease is still live at the same clock instant.
    expect((await b.tick()).embedded).toBe(0);
    expect(repo.embeddingStats().backlog).toBe(afterA);

    // Once A's lease lapses, B steals it and finishes the queue.
    clock.advanceMs(11_000);
    expect((await b.tick()).embedded).toBeGreaterThan(0);
    expect(repo.embeddingStats().backlog).toBe(0);
  });

  it("a worker keeps renewing its own lease across ticks", async () => {
    const { ctx, repo, provider, clock } = makeCtx();
    const s = await session(ctx);
    await writeFact(ctx, s, "solo");

    const w = new EmbeddingWorker(repo, provider, () => clock.t, { leaseTtlMs: 5_000 });
    expect((await w.tick()).embedded).toBeGreaterThan(0);
    await writeFact(ctx, s, "solo-2");
    clock.advanceMs(4_000); // within its own TTL — still the holder, no hand-off
    expect((await w.tick()).embedded).toBeGreaterThan(0);
    expect(repo.embeddingStats().backlog).toBe(0);
  });
});
