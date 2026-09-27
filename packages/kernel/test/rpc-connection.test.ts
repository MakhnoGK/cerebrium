import { rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeRpcConnections,
  onRpcNotification,
  rpcCall,
  RpcUnavailableError,
} from "@/runtime/rpc-client";
import { RpcServer } from "@/presentation/rpc";

const SOCKET = `/tmp/cb-conn-${String(process.pid)}.sock`;

let bare: Server | null = null;
let rpc: RpcServer | null = null;

interface Harness {
  connections: number;
  requests: { id: number; method: string }[];
}

// A raw socket server, so a test can decide exactly when a connection dies and what is
// answered. `RpcServer` always replies, which is the one thing these tests need not to.
function serveBare(
  onRequest: (socket: Socket, request: { id: number; method: string }, harness: Harness) => void,
): Harness {
  const harness: Harness = { connections: 0, requests: [] };

  bare = createServer((socket) => {
    harness.connections++;
    socket.setEncoding("utf8");

    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;

      let newline = buffer.indexOf("\n");

      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const request = JSON.parse(line) as { id: number; method: string };

        harness.requests.push(request);
        onRequest(socket, request, harness);

        newline = buffer.indexOf("\n");
      }
    });
    socket.on("error", () => undefined);
  });
  bare.listen(SOCKET);

  return harness;
}

function reply(socket: Socket, id: number, result: unknown): void {
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

afterEach(async () => {
  closeRpcConnections();
  await new Promise<void>((resolve) => {
    if (bare === null) {
      resolve();
      return;
    }

    bare.close(() => {
      resolve();
    });
  });
  bare = null;
  await rpc?.close();
  rpc = null;
  rmSync(SOCKET, { force: true });
});

describe("Held-open connection", () => {
  it("should reuse one connection across calls instead of dialling per request", async () => {
    // Given
    const harness = serveBare((socket, request) => {
      reply(socket, request.id, request.method);
    });

    // When
    await rpcCall({ socketPath: SOCKET }, "one");
    await rpcCall({ socketPath: SOCKET }, "two");
    await rpcCall({ socketPath: SOCKET }, "three");

    // Then
    expect(harness.connections).toBe(1);
    expect(harness.requests.map((r) => r.method)).toEqual(["one", "two", "three"]);
  });

  it("should give each in-flight call its own answer when they interleave", async () => {
    // Given — the second request is answered first, which a single shared connection can
    // only get right by correlating on the id.
    const held: { socket: Socket; id: number }[] = [];
    serveBare((socket, request) => {
      held.push({ socket, id: request.id });

      if (held.length === 2) {
        reply(held[1]!.socket, held[1]!.id, "second");
        reply(held[0]!.socket, held[0]!.id, "first");
      }
    });

    // When
    const [first, second] = await Promise.all([
      rpcCall({ socketPath: SOCKET }, "slow"),
      rpcCall({ socketPath: SOCKET }, "fast"),
    ]);

    // Then
    expect(first).toBe("first");
    expect(second).toBe("second");
  });

  it("should keep the connection usable after one call times out", async () => {
    // Given — the first request is never answered.
    serveBare((socket, request) => {
      if (request.method === "answered") reply(socket, request.id, "ok");
    });

    // When
    await expect(rpcCall({ socketPath: SOCKET, timeoutMs: 60 }, "ignored")).rejects.toBeInstanceOf(
      RpcUnavailableError,
    );

    // Then — a timeout is one call's problem, not the connection's.
    expect(await rpcCall({ socketPath: SOCKET }, "answered")).toBe("ok");
  });
});

describe("A connection dropped under a call in flight", () => {
  it("should send a retryable call again on a fresh connection", async () => {
    // Given — the daemon takes the request and dies without answering, which is what a
    // restart looks like from here.
    const harness = serveBare((socket, request, state) => {
      if (state.requests.length === 1) {
        socket.destroy();

        return;
      }

      reply(socket, request.id, "second time");
    });

    // When
    const answered = await rpcCall({ socketPath: SOCKET, retryable: true }, "search_memory");

    // Then
    expect(answered).toBe("second time");
    expect(harness.requests).toHaveLength(2);
    expect(harness.connections).toBe(2);
  });

  it("should never send a call that is not retryable twice", async () => {
    // Given — the daemon may already have applied it, and this is the whole reason the
    // read/write distinction exists.
    const harness = serveBare((socket) => {
      socket.destroy();
    });

    // When
    await expect(rpcCall({ socketPath: SOCKET }, "write_memory")).rejects.toBeInstanceOf(
      RpcUnavailableError,
    );

    // Then
    expect(harness.requests).toHaveLength(1);
  });

  it("should give up rather than resend forever", async () => {
    // Given
    const harness = serveBare((socket) => {
      socket.destroy();
    });

    // When
    await expect(
      rpcCall({ socketPath: SOCKET, retryable: true }, "search_memory"),
    ).rejects.toBeInstanceOf(RpcUnavailableError);

    // Then — one retry, not a loop.
    expect(harness.requests).toHaveLength(2);
  });
});

describe("The daemon speaking first", () => {
  it("should deliver a push to a client holding the connection open", async () => {
    // Given
    rpc = new RpcServer({ ping: () => Promise.resolve("pong") });
    await rpc.listen(SOCKET);

    const heard: { method: string; params: Record<string, unknown> }[] = [];
    onRpcNotification(SOCKET, (method, params) => {
      heard.push({ method, params });
    });

    // The connection only exists once something has been asked over it.
    await rpcCall({ socketPath: SOCKET }, "ping");

    // When
    const reached = rpc.broadcast("node.changed", { id: "01JJJJJJJJJJJJJJJJJJJJJJJJ" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Then
    expect(reached).toBe(1);
    expect(heard).toEqual([
      { method: "node.changed", params: { id: "01JJJJJJJJJJJJJJJJJJJJJJJJ" } },
    ]);
  });

  it("should not confuse a push with the answer to a pending call", async () => {
    // Given
    rpc = new RpcServer({
      slow: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));

        return "answer";
      },
    });
    await rpc.listen(SOCKET);

    const heard: string[] = [];
    onRpcNotification(SOCKET, (method) => {
      heard.push(method);
    });
    await rpcCall({ socketPath: SOCKET }, "slow");

    // When — a push lands while a call is waiting for its own reply.
    const pending = rpcCall({ socketPath: SOCKET }, "slow");
    await new Promise((resolve) => setTimeout(resolve, 20));
    rpc.broadcast("candidate.queued");

    // Then
    expect(await pending).toBe("answer");
    expect(heard).toEqual(["candidate.queued"]);
  });

  it("should stop delivering to a handler that unsubscribed", async () => {
    // Given
    rpc = new RpcServer({ ping: () => Promise.resolve("pong") });
    await rpc.listen(SOCKET);

    const heard: string[] = [];
    const stop = onRpcNotification(SOCKET, (method) => {
      heard.push(method);
    });
    await rpcCall({ socketPath: SOCKET }, "ping");

    // When
    rpc.broadcast("first");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stop();
    rpc.broadcast("second");
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Then
    expect(heard).toEqual(["first"]);
  });
});
