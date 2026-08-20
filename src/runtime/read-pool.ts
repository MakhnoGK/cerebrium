import { isControlRead, type ReadName } from "@/application/use-cases";

// The pool's side of the worker contract. An interface rather than `node:worker_threads`
// directly so the dispatch policy can be tested without spawning threads.
export interface PoolWorker {
  post(message: PoolRequest): void;
  onMessage(handler: (message: PoolResponse) => void): void;
  onError(handler: (error: Error) => void): void;
  terminate(): Promise<void>;
}

export interface PoolRequest {
  id: number;
  name: ReadName;
  args: unknown;
}

export type PoolResponse =
  { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

export interface ReadPoolOptions {
  spawn: () => PoolWorker;
  size: number;
  // Workers held back for control reads so `status` cannot queue behind a search. Ignored
  // when the pool is too small to partition.
  controlSlots?: number;
}

interface Slot {
  worker: PoolWorker;
  control: boolean;
  busy: boolean;
}

interface Pending {
  name: ReadName;
  args: unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class ReadPoolClosedError extends Error {}

export class ReadPool {
  private readonly slots: Slot[] = [];
  private readonly inflight = new Map<number, Pending>();
  private readonly owner = new Map<number, Slot>();
  private readonly waiting: Pending[] = [];
  private nextId = 1;
  private closed = false;

  constructor(private readonly options: ReadPoolOptions) {
    const size = Math.max(1, options.size);
    // A single worker cannot be both lanes, so partitioning is skipped rather than
    // starving data reads to hold a slot open.
    const control = size > 1 ? Math.min(options.controlSlots ?? 1, size - 1) : 0;

    for (let i = 0; i < size; i++) {
      this.slots.push(this.attach(i < control));
    }
  }

  get depth(): number {
    return this.waiting.length;
  }

  invoke(name: ReadName, args: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new ReadPoolClosedError("read pool is closed"));
    }

    return new Promise<unknown>((resolve, reject) => {
      const pending: Pending = { name, args, resolve, reject };
      const slot = this.free(name);

      if (slot) {
        this.dispatch(slot, pending);

        return;
      }

      this.waiting.push(pending);
    });
  }

  async close(): Promise<void> {
    this.closed = true;

    for (const pending of [...this.waiting, ...this.inflight.values()]) {
      pending.reject(new ReadPoolClosedError("read pool closed before this call finished"));
    }

    this.waiting.length = 0;
    this.inflight.clear();
    this.owner.clear();

    await Promise.all(this.slots.map((slot) => slot.worker.terminate()));
    this.slots.length = 0;
  }

  private attach(control: boolean): Slot {
    const worker = this.options.spawn();
    const slot: Slot = { worker, control, busy: false };

    worker.onMessage((message) => {
      this.settle(slot, message);
    });

    // A dead worker fails only the call it was running. Replacing the slot keeps the
    // pool's capacity constant instead of shrinking it with every crash.
    worker.onError((error) => {
      this.failInflightOn(slot, error);
      slot.busy = false;
      this.drain();
    });

    return slot;
  }

  // A control read may use a data worker when one is free, but never the reverse: the
  // reserved slots exist so a control read has somewhere to go when data saturates.
  private free(name: ReadName): Slot | undefined {
    const control = isControlRead(name);
    const ordered = control
      ? [...this.slots].sort((a, b) => Number(b.control) - Number(a.control))
      : this.slots.filter((slot) => !slot.control);

    return ordered.find((slot) => !slot.busy);
  }

  private dispatch(slot: Slot, pending: Pending): void {
    const id = this.nextId++;

    slot.busy = true;
    this.inflight.set(id, pending);
    this.owner.set(id, slot);
    slot.worker.post({ id, name: pending.name, args: pending.args });
  }

  private settle(slot: Slot, message: PoolResponse): void {
    const pending = this.inflight.get(message.id);

    slot.busy = false;

    if (pending) {
      this.inflight.delete(message.id);
      this.owner.delete(message.id);

      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error));
      }
    }

    this.drain();
  }

  private failInflightOn(slot: Slot, error: Error): void {
    for (const [id, pending] of this.inflight) {
      if (this.owner.get(id) === slot) {
        this.inflight.delete(id);
        this.owner.delete(id);
        pending.reject(error);
      }
    }
  }

  private drain(): void {
    for (let i = 0; i < this.waiting.length;) {
      const pending = this.waiting[i]!;
      const slot = this.free(pending.name);

      if (!slot) {
        i++;

        continue;
      }

      this.waiting.splice(i, 1);
      this.dispatch(slot, pending);
    }
  }
}
