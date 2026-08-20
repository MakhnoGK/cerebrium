import { rmSync, statSync, writeFileSync } from "node:fs";
import { container } from "tsyringe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rpcCall, rpcHandshake, RpcUnavailableError } from "@/runtime/rpc-client";
import { parseRequest, PROTOCOL_VERSION, RPC_ERROR, socketPathProblem } from "@/core/rpc";
import { createDaemonMethods, RpcServer, type RpcMethod } from "@/presentation/rpc";
import { setup } from "@test/helpers";

// Kept short deliberately: the macOS sun_path limit is 103 bytes and the system temp
// directory alone can eat most of that.
const SOCKET = `/tmp/cb-rpc-${String(process.pid)}.sock`;

let server: RpcServer | null = null;

async function serve(methods: Record<string, RpcMethod>): Promise<void> {
  server = new RpcServer(methods);
  await server.listen(SOCKET);
}

afterEach(async () => {
  await server?.close();
  server = null;
  rmSync(SOCKET, { force: true });
});

describe("Protocol parsing", () => {
  it("should reject a line that is not JSON", () => {
    // Given / When
    const parsed = parseRequest("{not json");

    // Then
    expect(parsed).toMatchObject({ ok: false, code: RPC_ERROR.parse });
  });

  it("should reject an envelope that is not JSON-RPC 2.0", () => {
    // Given / When
    const parsed = parseRequest(JSON.stringify({ jsonrpc: "1.0", id: 1, method: "status" }));

    // Then
    expect(parsed).toMatchObject({ ok: false, code: RPC_ERROR.invalidRequest, id: 1 });
  });

  it("should reject a request with no method", () => {
    // Given / When
    const parsed = parseRequest(JSON.stringify({ jsonrpc: "2.0", id: 7 }));

    // Then
    expect(parsed).toMatchObject({ ok: false, code: RPC_ERROR.invalidRequest, id: 7 });
  });

  it("should accept a well-formed request", () => {
    // Given / When
    const parsed = parseRequest(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: { a: 1 } }),
    );

    // Then
    expect(parsed).toMatchObject({ ok: true, request: { method: "status", params: { a: 1 } } });
  });
});

describe("Socket path limit", () => {
  it("should refuse a path over the platform limit and name the variable to change", () => {
    // Given
    const tooLong = `/Users/x/${"d".repeat(120)}/daemon.sock`;

    // When
    const problem = socketPathProblem(tooLong);

    // Then
    expect(problem).toContain("over the 103-byte platform limit");
    expect(problem).toContain("CEREBRIUM_HOME");
  });

  it("should accept a path within the limit", () => {
    // Given / When / Then
    expect(socketPathProblem("/Users/x/.cerebrium/daemon.sock")).toBeNull();
  });
});

describe("RPC server over a real socket", () => {
  it("should answer a request and reject an unknown method by name", async () => {
    // Given
    await serve({ ping: () => Promise.resolve({ pong: true }) });

    // When
    const answered = await rpcCall({ socketPath: SOCKET }, "ping");

    // Then
    expect(answered).toEqual({ pong: true });
    await expect(rpcCall({ socketPath: SOCKET }, "nope")).rejects.toThrow(/unknown method: nope/);
  });

  it("should create the socket owner-only", async () => {
    // Given
    await serve({ ping: () => Promise.resolve(1) });

    // When
    const mode = statSync(SOCKET).mode & 0o777;

    // Then
    expect(mode).toBe(0o600);
  });

  it("should surface a handler failure as an error response, not a dropped connection", async () => {
    // Given
    await serve({
      boom: () => Promise.reject(new Error("handler exploded")),
    });

    // When / Then
    await expect(rpcCall({ socketPath: SOCKET }, "boom")).rejects.toThrow(/handler exploded/);
  });

  it("should replace a stale socket file left by a crashed daemon", async () => {
    // Given — an inode at the address with nobody listening. A clean shutdown unlinks
    // the socket itself, so only a crash can leave this behind.
    writeFileSync(SOCKET, "");

    // When
    server = new RpcServer(
      { ping: () => Promise.resolve(2) },
      { isOwnedByLiveDaemon: () => false },
    );
    await server.listen(SOCKET);

    // Then
    expect(await rpcCall({ socketPath: SOCKET }, "ping")).toBe(2);
    expect(statSync(SOCKET).isSocket()).toBe(true);
  });

  it("should refuse to steal a socket a live daemon owns", async () => {
    // Given
    await serve({ ping: () => Promise.resolve(1) });

    // When
    const intruder = new RpcServer({}, { isOwnedByLiveDaemon: () => true });

    // Then
    await expect(intruder.listen(SOCKET)).rejects.toThrow(/another daemon is listening/);
    expect(await rpcCall({ socketPath: SOCKET }, "ping")).toBe(1);
  });
});

describe("RPC client failure modes", () => {
  it("should report an absent daemon as unavailable, distinctly from a daemon-side error", async () => {
    // Given / When / Then
    await expect(
      rpcCall({ socketPath: "/tmp/cb-rpc-does-not-exist.sock" }, "status"),
    ).rejects.toBeInstanceOf(RpcUnavailableError);
  });

  it("should refuse a daemon speaking a different protocol version", async () => {
    // Given — an older build's handshake.
    await serve({ initialize: () => Promise.resolve({ protocol: PROTOCOL_VERSION + 1 }) });

    // When / Then
    await expect(rpcHandshake({ socketPath: SOCKET })).rejects.toThrow(/cerebrium-service install/);
  });

  it("should accept a daemon on the matching protocol version", async () => {
    // Given
    await serve({ initialize: () => Promise.resolve({ protocol: PROTOCOL_VERSION }) });

    // When / Then
    await expect(rpcHandshake({ socketPath: SOCKET })).resolves.toBe(PROTOCOL_VERSION);
  });
});

describe("Daemon methods", () => {
  beforeEach(() => {
    setup();
  });

  it("should answer status while the model is still loading", async () => {
    // Given — `model` is null exactly as it is between listen() and a finished warm.
    await serve(createDaemonMethods(container, { pid: 4242, model: () => null }));

    // When
    const status = (await rpcCall({ socketPath: SOCKET }, "status")) as {
      daemon: { pid: number };
      content: { nodes_total: number };
    };

    // Then
    expect(status.daemon.pid).toBe(4242);
    expect(status.content.nodes_total).toBeGreaterThanOrEqual(0);
  });

  it("should report a load that failed, rather than refusing to answer", async () => {
    // Given
    await serve(
      createDaemonMethods(container, {
        pid: 7,
        model: () => ({ state: "failed", ms: 329, error: "no such file" }),
      }),
    );

    // When
    const status = (await rpcCall({ socketPath: SOCKET }, "status")) as {
      daemon: { state: string; error: string };
    };

    // Then
    expect(status.daemon.state).toBe("failed");
    expect(status.daemon.error).toBe("no such file");
  });

  it("should report the protocol version on initialize", async () => {
    // Given
    await serve(createDaemonMethods(container, { pid: 1, model: () => null }));

    // When / Then
    expect(await rpcCall({ socketPath: SOCKET }, "initialize")).toEqual({
      protocol: PROTOCOL_VERSION,
      pid: 1,
    });
  });
});
