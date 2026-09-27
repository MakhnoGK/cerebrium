import { describe, expect, it } from "vitest";
import {
  ReadPool,
  ReadPoolClosedError,
  type PoolRequest,
  type PoolWorker,
} from "@/runtime/read-pool";

// A worker that never answers on its own: the test decides when each call completes, which
// is what makes "was this call queued behind that one" observable.
class FakeWorker implements PoolWorker {
  readonly received: PoolRequest[] = [];
  terminated = false;
  private message: ((m: never) => void) | undefined;
  private error: ((e: Error) => void) | undefined;

  post(message: PoolRequest): void {
    this.received.push(message);
  }

  onMessage(handler: (message: never) => void): void {
    this.message = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.error = handler;
  }

  terminate(): Promise<void> {
    this.terminated = true;

    return Promise.resolve();
  }

  finish(id: number, result: unknown): void {
    this.message?.({ id, ok: true, result } as never);
  }

  fail(id: number, error: string): void {
    this.message?.({ id, ok: false, error } as never);
  }

  crash(error: Error): void {
    this.error?.(error);
  }
}

function pool(size: number, controlSlots?: number) {
  const workers: FakeWorker[] = [];
  const p = new ReadPool({
    size,
    ...(controlSlots === undefined ? {} : { controlSlots }),
    spawn: () => {
      const w = new FakeWorker();
      workers.push(w);

      return w;
    },
  });

  return { p, workers };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("ReadPool dispatch", () => {
  it("should spawn the requested number of workers", () => {
    // Given / When
    const { workers } = pool(3);

    // Then
    expect(workers).toHaveLength(3);
  });

  it("should run calls on different workers instead of serialising them", async () => {
    // Given
    const { p, workers } = pool(3);

    // When — two data reads with nothing completing in between.
    void p.invoke("search_memory", { q: 1 });
    void p.invoke("search_memory", { q: 2 });
    await tick();

    // Then — the data lane is workers[1] and workers[2]; workers[0] is reserved.
    expect(workers[1]!.received).toHaveLength(1);
    expect(workers[2]!.received).toHaveLength(1);
    expect(workers[0]!.received).toHaveLength(0);
  });

  it("should queue a data read when every data worker is busy", async () => {
    // Given — size 3, so one control slot and two data workers.
    const { p, workers } = pool(3);
    void p.invoke("search_memory", { q: 1 });
    void p.invoke("search_memory", { q: 2 });
    await tick();

    // When
    void p.invoke("search_memory", { q: 3 });
    await tick();

    // Then — it waits rather than stealing the reserved worker.
    expect(p.depth).toBe(1);
    expect(workers[0]!.received).toHaveLength(0);
  });

  it("should answer a control read while every data worker is busy", async () => {
    // Given
    const { p, workers } = pool(3);
    void p.invoke("search_memory", { q: 1 });
    void p.invoke("search_memory", { q: 2 });
    await tick();
    expect(workers[1]!.received).toHaveLength(1);
    expect(workers[2]!.received).toHaveLength(1);

    // When — this is the case S1d exists to fix: status must not wait for a search.
    const status = p.invoke("operator_snapshot", {});
    await tick();
    expect(workers[0]!.received).toHaveLength(1);
    workers[0]!.finish(workers[0]!.received[0]!.id, { ok: true });

    // Then
    await expect(status).resolves.toEqual({ ok: true });
    expect(p.depth).toBe(0);
  });

  it("should hand a queued call to the next worker that frees up", async () => {
    // Given
    const { p, workers } = pool(3);
    void p.invoke("search_memory", { q: 1 });
    void p.invoke("search_memory", { q: 2 });
    await tick();
    const third = p.invoke("search_memory", { q: 3 });
    await tick();
    expect(p.depth).toBe(1);

    // When
    workers[1]!.finish(workers[1]!.received[0]!.id, "first done");
    await tick();
    workers[1]!.finish(workers[1]!.received[1]!.id, "third done");

    // Then
    await expect(third).resolves.toBe("third done");
    expect(p.depth).toBe(0);
  });

  it("should reject only the call a crashed worker was running", async () => {
    // Given
    const { p, workers } = pool(3);
    const doomed = p.invoke("search_memory", { q: 1 });
    const other = p.invoke("search_memory", { q: 2 });
    await tick();

    // When
    workers[1]!.crash(new Error("worker died"));

    // Then
    await expect(doomed).rejects.toThrow(/worker died/);
    workers[2]!.finish(workers[2]!.received[0]!.id, "survived");
    await expect(other).resolves.toBe("survived");
  });

  it("should surface a worker-reported failure as a rejection", async () => {
    // Given
    const { p, workers } = pool(2);
    const call = p.invoke("search_memory", { q: 1 });
    await tick();

    // When
    workers[1]!.fail(workers[1]!.received[0]!.id, "no such table");

    // Then
    await expect(call).rejects.toThrow(/no such table/);
  });

  it("should share the one worker between both lanes when it cannot partition", async () => {
    // Given / When
    const { p, workers } = pool(1);
    void p.invoke("search_memory", { q: 1 });
    await tick();

    // Then — reserving the only worker would starve data reads entirely.
    expect(workers[0]!.received).toHaveLength(1);
    expect(p.depth).toBe(0);
  });

  it("should reject in-flight and queued calls on close, and terminate every worker", async () => {
    // Given
    const { p, workers } = pool(2);
    const inflight = p.invoke("search_memory", { q: 1 });
    await tick();
    const queued = p.invoke("search_memory", { q: 2 });

    // When
    await p.close();

    // Then
    await expect(inflight).rejects.toBeInstanceOf(ReadPoolClosedError);
    await expect(queued).rejects.toBeInstanceOf(ReadPoolClosedError);
    expect(workers.every((w) => w.terminated)).toBe(true);
    await expect(p.invoke("search_memory", {})).rejects.toBeInstanceOf(ReadPoolClosedError);
  });
});
