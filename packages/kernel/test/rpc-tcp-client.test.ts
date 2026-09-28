import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { container } from "tsyringe";
import { afterEach, describe, expect, it } from "vitest";
import { SEARCH_MEMORY, type SearchMemory } from "@/application/use-cases";
import { explicitKernel } from "@/runtime/kernel-choice";
import { DaemonUnreachableError } from "@/runtime/remote-kernel";
import { closeRpcConnections, RpcAuthError, rpcCall, rpcHandshake } from "@/runtime/rpc-client";
import { RpcServer, surfaceMethods, type NetworkAuth, type RpcMethod } from "@/presentation/rpc";
import { buildContainer } from "@/container";
import { KernelConfig, StaticConfigSource } from "@/infrastructure/config";

const SOCKET = `/tmp/cb-tcpc-${String(process.pid)}.sock`;

let rpc: RpcServer | null = null;
let bare: Server | null = null;
const dirs: string[] = [];

function auth(tokens: Record<string, string>): NetworkAuth & { presented: string[] } {
  const presented: string[] = [];

  return {
    presented,
    methods: new Set(["initialize", "health", "slow", "search_memory"]),
    authenticate(token) {
      presented.push(token);

      return Promise.resolve(tokens[token] === undefined ? null : { principal: tokens[token] });
    },
  };
}

async function serve(methods: Record<string, RpcMethod>, network: NetworkAuth): Promise<string> {
  rpc = new RpcServer({
    initialize: (_p, meta) => Promise.resolve({ protocol: 2, principal: meta.principal }),
    ...methods,
  });
  await rpc.listen(SOCKET);
  const { port } = await rpc.listenTcp("127.0.0.1", 0, network);

  return `tcp://127.0.0.1:${String(port)}`;
}

function tokenFile(value: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cb-token-"));
  const file = join(dir, "token");

  dirs.push(dir);
  writeFileSync(file, value, { mode: 0o600 });

  return file;
}

afterEach(async () => {
  closeRpcConnections();
  await rpc?.close();
  rpc = null;
  const held = bare;
  bare = null;
  if (held !== null) {
    await new Promise<void>((resolve) => {
      held.close(() => {
        resolve();
      });
    });
  }
  rmSync(SOCKET, { force: true });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("TCP client", () => {
  it("should present its token once per connection and then call as the principal", async () => {
    // Given
    const network = auth({ "tok-1": "mac-claude" });
    const url = await serve(
      { health: (_p, meta) => Promise.resolve({ principal: meta.principal }) },
      network,
    );

    // When
    const protocol = await rpcHandshake({ socketPath: url, token: "tok-1" });
    const first = await rpcCall({ socketPath: url, token: "tok-1" }, "health");
    const second = await rpcCall({ socketPath: url, token: "tok-1" }, "health");

    // Then
    expect(protocol).toBe(2);
    expect(first).toEqual({ principal: "mac-claude" });
    expect(second).toEqual({ principal: "mac-claude" });
    expect(network.presented[0]).toBe("tok-1");
  });

  it("should fail with an auth error, and not resend, when the token is refused", async () => {
    // Given
    const network = auth({ "tok-1": "mac-claude" });
    const url = await serve({ health: () => Promise.resolve({}) }, network);

    // When
    const call = rpcCall({ socketPath: url, token: "forged", retryable: true }, "health");

    // Then
    await expect(call).rejects.toBeInstanceOf(RpcAuthError);
    await expect(call).rejects.toThrow(/invalid or revoked token/);
    expect(network.presented).toEqual(["forged"]);
  });

  it("should reconnect a retryable read after the server drops the connection", async () => {
    // Given
    const initializes: string[] = [];
    const sockets: Socket[] = [];
    bare = createServer((socket) => {
      sockets.push(socket);
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const request = JSON.parse(buffer.slice(0, newline)) as {
            id: number;
            method: string;
            params: { token?: string };
          };
          buffer = buffer.slice(newline + 1);
          if (request.method === "initialize") initializes.push(request.params.token ?? "");
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })}\n`);
          newline = buffer.indexOf("\n");
        }
      });
      socket.on("error", () => undefined);
    });
    const server = bare;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const port = (server.address() as { port: number }).port;
    const url = `tcp://127.0.0.1:${String(port)}`;
    await rpcCall({ socketPath: url, token: "tok-1" }, "health");

    // When
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => setTimeout(r, 20));
    await rpcCall({ socketPath: url, token: "tok-1", retryable: true }, "health");

    // Then
    expect(initializes).toEqual(["tok-1", "tok-1"]);
  });

  it("should give up on a call at its deadline and name the url", async () => {
    // Given
    const url = await serve(
      { slow: () => new Promise(() => undefined) },
      auth({ "tok-1": "mac-claude" }),
    );

    // When
    const started = Date.now();
    const call = rpcCall({ socketPath: url, token: "tok-1", timeoutMs: 200 }, "slow");

    // Then
    await expect(call).rejects.toThrow(`no response from ${url} in 200ms`);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("Explicit kernel", () => {
  const config = (url: string | null, tokenFile: string | null): KernelConfig =>
    Object.assign(Object.create(KernelConfig.prototype) as KernelConfig, { url, tokenFile });

  it("should mean the local daemon when no url is configured", () => {
    // Given / When / Then
    expect(explicitKernel(config(null, null))).toBeNull();
  });

  it("should refuse a tcp url without a token file", () => {
    // Given / When / Then
    expect(() => explicitKernel(config("tcp://100.92.157.103:7433", null))).toThrow(
      /MEMORY_KERNEL_TOKEN_FILE is not set/,
    );
  });

  it("should read and trim the token file", () => {
    // Given
    const file = tokenFile("cbr_abc\n");

    // When / Then
    expect(explicitKernel(config("tcp://h:7433", file))).toEqual({
      url: "tcp://h:7433",
      token: "cbr_abc",
    });
  });

  it("should refuse an empty token file", () => {
    // Given
    const file = tokenFile("\n");

    // When / Then
    expect(() => explicitKernel(config("tcp://h:7433", file))).toThrow(/is empty/);
  });

  it("should route the remote kernel's use cases to the configured url", async () => {
    // Given
    const network = auth({ "tok-1": "mac-claude" });
    const seen: unknown[] = [];
    const url = await serve(
      surfaceMethods((name, _args, writer) => {
        seen.push({ name, writer });

        return Promise.resolve({ results: [], total_matches: 0 });
      }),
      network,
    );
    const remote = buildContainer({
      role: "server",
      kernel: "remote",
      into: container.createChildContainer(),
      source: new StaticConfigSource({
        MEMORY_KERNEL_URL: url,
        MEMORY_KERNEL_TOKEN_FILE: tokenFile("tok-1"),
        MEMORY_DAEMON_SOCKET: "/nonexistent/daemon.sock",
        MEMORY_DB_PATH: "/nonexistent/x.db",
      }),
    });

    // When
    await remote.resolve<SearchMemory>(SEARCH_MEMORY).invoke({ query: "anything", limit: 5 });

    // Then
    expect(seen).toEqual([
      {
        name: "search_memory",
        writer: { client: null, version: null, principal: "mac-claude" },
      },
    ]);
  });

  it("should tell the agent to check the host when a tcp kernel is unreachable", async () => {
    // Given
    const remote = buildContainer({
      role: "server",
      kernel: "remote",
      into: container.createChildContainer(),
      source: new StaticConfigSource({
        MEMORY_KERNEL_URL: "tcp://127.0.0.1:1",
        MEMORY_KERNEL_TOKEN_FILE: tokenFile("tok-1"),
        MEMORY_DB_PATH: "/nonexistent/x.db",
      }),
    });

    // When
    const call = remote.resolve<SearchMemory>(SEARCH_MEMORY).invoke({ query: "x", limit: 1 });

    // Then
    await expect(call).rejects.toBeInstanceOf(DaemonUnreachableError);
    await expect(call).rejects.toThrow(/tcp:\/\/127\.0\.0\.1:1.*whether the host is up/);
  });
});
