import { rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseRequest, RPC_ERROR, type RpcMeta } from "@cerebrium/contracts/rpc";
import { closeRpcConnections, rpcCall } from "@/runtime/rpc-client";
import { RpcServer, type NetworkAuth, type RpcMethod } from "@/presentation/rpc";

const SOCKET = `/tmp/cb-net-${String(process.pid)}.sock`;

let server: RpcServer | null = null;
const open: Socket[] = [];

interface Seen {
  method: string;
  meta: RpcMeta;
}

function methods(seen: Seen[]): Record<string, RpcMethod> {
  const record =
    (method: string): RpcMethod =>
    (_params, meta) => {
      seen.push({ method, meta });

      return Promise.resolve({ method, principal: meta.principal ?? null });
    };

  return {
    initialize: record("initialize"),
    health: record("health"),
    search_memory: record("search_memory"),
    status: record("status"),
  };
}

function authWith(tokens: Map<string, string>, delayMs = 0): NetworkAuth & { calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
    methods: new Set(["initialize", "health", "search_memory"]),
    async authenticate(token) {
      calls.push(token);

      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

      const principal = tokens.get(token);

      return principal === undefined ? null : { principal };
    },
  };
}

async function serve(
  seen: Seen[],
  auth: NetworkAuth,
): Promise<{ port: number; server: RpcServer }> {
  server = new RpcServer(methods(seen));
  await server.listen(SOCKET);
  const { port } = await server.listenTcp("127.0.0.1", 0, auth);

  return { port, server };
}

interface Wire {
  send(frames: unknown[]): void;
  next(): Promise<Record<string, unknown>>;
  closed: Promise<void>;
}

function wire(port: number): Wire {
  const socket = connect(port, "127.0.0.1");
  const lines: Record<string, unknown>[] = [];
  const waiting: ((line: Record<string, unknown>) => void)[] = [];
  let buffer = "";

  open.push(socket);
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;

    let newline = buffer.indexOf("\n");

    while (newline >= 0) {
      const line = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      buffer = buffer.slice(newline + 1);
      const waiter = waiting.shift();

      if (waiter) waiter(line);
      else lines.push(line);

      newline = buffer.indexOf("\n");
    }
  });

  return {
    send(frames) {
      socket.write(frames.map((f) => `${JSON.stringify(f)}\n`).join(""));
    },
    next() {
      const line = lines.shift();

      return line
        ? Promise.resolve(line)
        : new Promise((resolve) => {
            waiting.push(resolve);
          });
    },
    closed: new Promise((resolve) => {
      socket.on("close", () => {
        resolve();
      });
    }),
  };
}

const frame = (id: number, method: string, params: object = {}, meta?: object) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
  ...(meta === undefined ? {} : { meta }),
});

afterEach(async () => {
  for (const socket of open.splice(0)) socket.destroy();
  closeRpcConnections();
  await server?.close();
  server = null;
  rmSync(SOCKET, { force: true });
});

describe("Network listener handshake", () => {
  it("should answer initialize with a live token and run later calls as its principal", async () => {
    // Given
    const seen: Seen[] = [];
    const { port } = await serve(seen, authWith(new Map([["good", "mac-claude"]])));
    const client = wire(port);

    // When
    client.send([frame(1, "initialize", { token: "good" })]);
    const hello = await client.next();
    client.send([frame(2, "search_memory", {}, { client: "claude-code", version: "1" })]);
    const answer = await client.next();

    // Then
    expect(hello).toMatchObject({ id: 1, result: { principal: "mac-claude" } });
    expect(answer).toMatchObject({ id: 2, result: { principal: "mac-claude" } });
    expect(seen[1]!.meta).toEqual({ client: "claude-code", version: "1", principal: "mac-claude" });
  });

  it("should ignore a principal or client the caller puts in meta", async () => {
    // Given
    const seen: Seen[] = [];
    const { port } = await serve(seen, authWith(new Map([["good", "mac-claude"]])));
    const client = wire(port);

    // When
    client.send([
      frame(1, "initialize", { token: "good" }),
      frame(2, "search_memory", {}, { client: "cerebrium-runner", principal: "admin" }),
    ]);
    await client.next();
    const answer = await client.next();

    // Then
    expect(answer).toMatchObject({ result: { principal: "mac-claude" } });
    expect(seen[1]!.meta.principal).toBe("mac-claude");
  });

  it("should close a connection whose first frame carries no token", async () => {
    // Given
    const seen: Seen[] = [];
    const { port } = await serve(seen, authWith(new Map([["good", "mac-claude"]])));
    const client = wire(port);

    // When
    client.send([frame(1, "initialize", {})]);
    const refused = await client.next();
    await client.closed;

    // Then
    expect(refused).toMatchObject({ id: 1, error: { code: RPC_ERROR.unauthorized } });
    expect(seen).toEqual([]);
  });

  it("should close a connection whose first frame is not initialize, without running it", async () => {
    // Given
    const seen: Seen[] = [];
    const { port } = await serve(seen, authWith(new Map([["good", "mac-claude"]])));
    const client = wire(port);

    // When
    client.send([frame(1, "search_memory", { token: "good" })]);
    const refused = await client.next();
    await client.closed;

    // Then
    expect(refused).toMatchObject({ error: { code: RPC_ERROR.unauthorized } });
    expect(seen).toEqual([]);
  });

  it("should close a connection that presents an unknown token", async () => {
    // Given
    const seen: Seen[] = [];
    const { port } = await serve(seen, authWith(new Map([["good", "mac-claude"]])));
    const client = wire(port);

    // When
    client.send([frame(1, "initialize", { token: "forged" }), frame(2, "search_memory")]);
    const refused = await client.next();
    await client.closed;

    // Then
    expect(refused).toMatchObject({
      id: 1,
      error: { code: RPC_ERROR.unauthorized, message: "invalid or revoked token" },
    });
    expect(seen).toEqual([]);
  });

  it("should close a held connection once its token is revoked", async () => {
    // Given
    const tokens = new Map([["good", "mac-claude"]]);
    const seen: Seen[] = [];
    const { port } = await serve(seen, authWith(tokens));
    const client = wire(port);
    client.send([frame(1, "initialize", { token: "good" })]);
    await client.next();

    // When
    tokens.delete("good");
    client.send([frame(2, "search_memory")]);
    const refused = await client.next();
    await client.closed;

    // Then
    expect(refused).toMatchObject({
      id: 2,
      error: { code: RPC_ERROR.unauthorized, message: "the token was revoked" },
    });
    expect(seen.map((s) => s.method)).toEqual(["initialize"]);
  });

  it("should hold frames sent before the verdict and run them as the principal", async () => {
    // Given
    const seen: Seen[] = [];
    const { port } = await serve(seen, authWith(new Map([["good", "mac-claude"]]), 50));
    const client = wire(port);

    // When
    client.send([
      frame(1, "initialize", { token: "good" }),
      frame(2, "search_memory"),
      frame(3, "health"),
    ]);
    const answers = [await client.next(), await client.next(), await client.next()];

    // Then
    expect(answers.map((a) => a.id).sort()).toEqual([1, 2, 3]);
    expect(seen.every((s) => s.meta.principal === "mac-claude")).toBe(true);
  });
});

describe("Network listener surface", () => {
  it("should not serve a daemon method over tcp", async () => {
    // Given
    const seen: Seen[] = [];
    const { port } = await serve(seen, authWith(new Map([["good", "mac-claude"]])));
    const client = wire(port);
    client.send([frame(1, "initialize", { token: "good" })]);
    await client.next();

    // When
    client.send([frame(2, "status")]);
    const answer = await client.next();

    // Then
    expect(answer).toMatchObject({ id: 2, error: { code: RPC_ERROR.methodNotFound } });
    expect(seen.map((s) => s.method)).toEqual(["initialize"]);
  });

  it("should keep serving every method on the unix socket, with no principal", async () => {
    // Given
    const seen: Seen[] = [];
    await serve(seen, authWith(new Map()));

    // When
    const answer = await rpcCall({ socketPath: SOCKET }, "status", {}, { client: "claude-code" });

    // Then
    expect(answer).toEqual({ method: "status", principal: null });
  });

  it("should never read a principal off the wire", () => {
    // Given / When
    const parsed = parseRequest(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x", meta: { principal: "admin" } }),
    );

    // Then
    expect(parsed).toMatchObject({ ok: true, request: { meta: { client: null, version: null } } });
    expect(parsed.ok && parsed.request.meta).not.toHaveProperty("principal");
  });
});
