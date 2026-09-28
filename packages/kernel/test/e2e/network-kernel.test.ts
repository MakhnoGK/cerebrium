import "reflect-metadata";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { container, type DependencyContainer } from "tsyringe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryKind } from "@cerebrium/contracts/vocab";
import { CONSOLIDATION_PROVIDER_TOKEN } from "@/domain/ports/consolidation-provider";
import { EMBEDDING_PROVIDER_TOKEN } from "@/domain/ports/embedding-provider";
import { NODES_REPO_TOKEN, STORE_TOKEN, type Store } from "@/domain/ports/storage";
import { USE_RECORDER_TOKEN } from "@/domain/ports/use-recorder";
import { CallPipeline } from "@/application/call-pipeline";
import { PrincipalTokenService } from "@/application/services";
import { PG_TOKEN, type PgDatabase } from "@/db/postgres/database";
import { closeRpcConnections, rpcCall } from "@/runtime/rpc-client";
import { Server } from "@/presentation/mcp/server";
import { createDaemonMethods, networkMethods, RpcServer, surfaceMethods } from "@/presentation/rpc";
import { createConsolidator } from "@/consolidation";
import { buildContainer } from "@/container";
import { createProvider } from "@/embeddings";
import { StaticConfigSource } from "@/infrastructure/config";
import { freshStore } from "@test/helpers";
import { TEST_BACKEND } from "@test/pg";

let daemon: DependencyContainer;
let rpc: RpcServer;
let url: string;
let dir: string;

async function startDaemon(): Promise<void> {
  daemon = container.createChildContainer();
  freshStore(daemon);
  daemon.register(USE_RECORDER_TOKEN, { useToken: NODES_REPO_TOKEN });
  daemon.register(CONSOLIDATION_PROVIDER_TOKEN, { useValue: createConsolidator() });
  daemon.register(EMBEDDING_PROVIDER_TOKEN, { useValue: createProvider("local-null") });

  const pipeline = daemon.resolve(CallPipeline);
  const tokens = daemon.resolve(PrincipalTokenService);

  rpc = new RpcServer({
    ...surfaceMethods((name, args, writer) => pipeline.invoke(daemon, name, args, writer)),
    ...createDaemonMethods(daemon, {
      pid: process.pid,
      model: () => null,
      store: async () => {
        await daemon.resolve<Store>(STORE_TOKEN).ping();

        return { backend: "postgres", ready: true };
      },
    }),
  });

  const { port } = await rpc.listenTcp("127.0.0.1", 0, {
    authenticate: (token) => tokens.authenticate(token),
    methods: networkMethods(),
  });

  url = `tcp://127.0.0.1:${String(port)}`;
}

async function issue(principal: string): Promise<{ token: string; file: string }> {
  const { token } = await daemon.resolve(PrincipalTokenService).issue(principal, "e2e");
  const file = join(dir, principal);

  writeFileSync(file, `${token}\n`, { mode: 0o600 });

  return { token, file };
}

async function mcpClient(tokenFile: string): Promise<Client> {
  const remote = buildContainer({
    role: "server",
    kernel: "remote",
    into: container.createChildContainer(),
    source: new StaticConfigSource({
      MEMORY_KERNEL_URL: url,
      MEMORY_KERNEL_TOKEN_FILE: tokenFile,
      MEMORY_DAEMON_SOCKET: "/nonexistent/daemon.sock",
      MEMORY_DB_PATH: "/nonexistent/x.db",
    }),
  });
  const client = new Client({ name: "claude-code", version: "9.9.9" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await remote.resolve(Server).connect(serverTransport);
  await client.connect(clientTransport);

  return client;
}

function payload<T>(res: unknown): T {
  const r = res as { isError?: boolean; content: { text: string }[] };

  if (r.isError) throw new Error(`tool returned isError: ${r.content[0]?.text ?? ""}`);

  return JSON.parse(r.content[0]!.text) as T;
}

function errorText(res: unknown): string {
  const r = res as { isError?: boolean; content: { text: string }[] };

  return r.isError === true ? (r.content[0]?.text ?? "") : "";
}

async function sql<T>(text: string, params: Record<string, unknown>): Promise<T[]> {
  return (await daemon.resolve<PgDatabase>(PG_TOKEN).query(text, params)).rows as T[];
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);

  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function handshakeMs(token: string): Promise<number> {
  const started = performance.now();
  const { port, hostname } = new URL(url.replace("tcp://", "http://"));

  await new Promise<void>((resolve, reject) => {
    const socket = connect(Number(port), hostname);

    socket.setEncoding("utf8");
    socket.once("data", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
    socket.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { token } })}\n`,
    );
  });

  return performance.now() - started;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "cb-netk-"));
  await startDaemon();
});

afterEach(async () => {
  closeRpcConnections();
  await rpc.close();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(TEST_BACKEND !== "postgres")("MCP server on a network kernel", () => {
  it("should serve a session end to end as the token's principal", async () => {
    // Given
    const { file } = await issue("mac-claude");
    const client = await mcpClient(file);

    // When
    const { session_id } = payload<{ session_id: string }>(
      await client.callTool({ name: "session_start", arguments: { project: "e2e" } }),
    );
    const written = payload<{ id: string }>(
      await client.callTool({
        name: "write",
        arguments: {
          session_id,
          parent_node_id: null,
          memory_kind: MemoryKind.SEMANTIC,
          type: "fact",
          title: "Network kernel fact",
          content: "the host serves the kernel over the tailnet with a token per principal",
          project: "e2e",
        },
      }),
    );
    const fetched = payload<{ nodes: { id: string; content: string }[] }>(
      await client.callTool({ name: "get", arguments: { session_id, ids: [written.id] } }),
    );

    // Then
    expect(fetched.nodes[0]).toMatchObject({ id: written.id });
    expect(fetched.nodes[0]!.content).toContain("token per principal");
    expect(
      await sql("SELECT client, client_version, principal_id FROM sessions WHERE id = @id", {
        id: session_id,
      }),
    ).toEqual([{ client: "claude-code", client_version: "9.9.9", principal_id: "mac-claude" }]);
    expect(
      await sql<{ action: string }>(
        "SELECT action FROM events WHERE session_id = @id ORDER BY ts, id",
        { id: session_id },
      ),
    ).not.toHaveLength(0);
  });

  it("should refuse one principal's call on another principal's session", async () => {
    // Given
    const claude = await mcpClient((await issue("mac-claude")).file);
    const { session_id } = payload<{ session_id: string }>(
      await claude.callTool({ name: "session_start", arguments: {} }),
    );
    const codex = await mcpClient((await issue("mac-codex")).file);

    // When
    const res = await codex.callTool({ name: "search", arguments: { session_id, query: "x" } });

    // Then
    expect(errorText(res)).toMatch(/belongs to another principal/);
  });

  it("should answer health and new handshakes quickly while writes are running", async () => {
    // Given
    const writer = await issue("load-writer");
    const probe = await issue("probe");
    const as = { socketPath: url, token: writer.token };
    const { session_id } = (await rpcCall(as, "start_session", {}, { client: "load" })) as {
      session_id: string;
    };
    let writing = true;
    let writes = 0;
    const failures: string[] = [];
    const lane = async (n: number): Promise<void> => {
      while (writing) {
        await rpcCall(as, "write_memory", {
          session_id,
          project: "e2e",
          parent_node_id: null,
          memory_kind: MemoryKind.SEMANTIC,
          type: "fact",
          title: `Load ${String(n)}-${String(writes)}`,
          content: `lane ${String(n)} write ${String(writes)} with enough words to embed a chunk`,
        });
        writes++;
      }
    };
    const load = [0, 1, 2, 3].map((n) =>
      lane(n).catch((err: unknown) => {
        failures.push((err as Error).message);
        writing = false;
      }),
    );

    // When
    const health: number[] = [];
    const handshakes: number[] = [];

    for (let i = 0; i < 200; i++) {
      const started = performance.now();

      await rpcCall({ socketPath: url, token: probe.token }, "health");
      health.push(performance.now() - started);

      if (i % 4 === 0) handshakes.push(await handshakeMs(probe.token));
    }

    writing = false;
    await Promise.all(load);

    expect(failures).toEqual([]);

    // Then
    const report = {
      writes,
      health_p50: percentile(health, 50),
      health_p95: percentile(health, 95),
      health_max: Math.max(...health),
      handshake_p50: percentile(handshakes, 50),
      handshake_p95: percentile(handshakes, 95),
    };
    console.log(`network kernel latency under write load: ${JSON.stringify(report)}`);
    expect(writes).toBeGreaterThan(0);
    expect(report.health_p95).toBeLessThan(250);
    expect(report.handshake_p95).toBeLessThan(250);
  });
});
