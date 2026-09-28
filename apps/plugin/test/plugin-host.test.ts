import "reflect-metadata";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { container, type DependencyContainer } from "tsyringe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryKind } from "@cerebrium/contracts/vocab";
import { CallPipeline } from "@cerebrium/kernel/application/call-pipeline";
import { PrincipalTokenService } from "@cerebrium/kernel/application/services";
import { createConsolidator } from "@cerebrium/kernel/consolidation";
import { PG_TOKEN, type PgDatabase } from "@cerebrium/kernel/db/postgres/database";
import { CONSOLIDATION_PROVIDER_TOKEN } from "@cerebrium/kernel/domain/ports/consolidation-provider";
import { EMBEDDING_PROVIDER_TOKEN } from "@cerebrium/kernel/domain/ports/embedding-provider";
import { NODES_REPO_TOKEN, STORE_TOKEN, type Store } from "@cerebrium/kernel/domain/ports/storage";
import { USE_RECORDER_TOKEN } from "@cerebrium/kernel/domain/ports/use-recorder";
import { createProvider } from "@cerebrium/kernel/embeddings";
import {
  createDaemonMethods,
  networkMethods,
  RpcServer,
  surfaceMethods,
} from "@cerebrium/kernel/presentation/rpc";
import { freshStore } from "@test/helpers";
import { TEST_BACKEND } from "@test/pg";
import { pluginBundle } from "./plugin-bundle";

let daemon: DependencyContainer;
let rpc: RpcServer;
let url: string;
let dir: string;
const clients: Client[] = [];

async function startHost(): Promise<void> {
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

async function tokenFile(principal: string): Promise<string> {
  const { token } = await daemon.resolve(PrincipalTokenService).issue(principal, "plugin-e2e");
  const file = join(dir, principal);

  writeFileSync(file, `${token}\n`, { mode: 0o600 });

  return file;
}

async function plugin(file: string, home: string): Promise<Client> {
  const { server } = await pluginBundle();
  const client = new Client({ name: "claude-code", version: "9.9.9" });

  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [server],
      env: {
        PATH: process.env.PATH ?? "",
        CEREBRIUM_HOME: home,
        MEMORY_KERNEL_URL: url,
        MEMORY_KERNEL_TOKEN_FILE: file,
      },
      stderr: "ignore",
    }),
  );
  clients.push(client);

  return client;
}

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

function payload<T>(res: unknown): T {
  const r = res as ToolResult;

  if (r.isError) throw new Error(`tool returned isError: ${r.content[0]?.text ?? ""}`);

  return JSON.parse(r.content[0]!.text) as T;
}

async function sql<T>(text: string, params: Record<string, unknown>): Promise<T[]> {
  return (await daemon.resolve<PgDatabase>(PG_TOKEN).query(text, params)).rows as T[];
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "cb-plugin-host-"));
  await startHost();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await rpc.close();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(TEST_BACKEND !== "postgres")("The plugin bundle against a host", () => {
  it("should serve a session end to end as the token's principal and keep nothing locally", async () => {
    // Given
    const home = join(dir, "home");
    const client = await plugin(await tokenFile("mac-claude"), home);

    // When
    const { session_id } = payload<{ session_id: string }>(
      await client.callTool({ name: "session_start", arguments: { project: "plugin-e2e" } }),
    );
    const written = payload<{ id: string }>(
      await client.callTool({
        name: "write",
        arguments: {
          session_id,
          parent_node_id: null,
          memory_kind: MemoryKind.SEMANTIC,
          type: "fact",
          title: "Plugin bundle fact",
          content: "the thin plugin reaches the host kernel over tcp with its own token",
          project: "plugin-e2e",
        },
      }),
    );
    const found = payload<{ results: { id: string }[] }>(
      await client.callTool({
        name: "search",
        arguments: { session_id, query: "thin plugin host kernel", mode: "text" },
      }),
    );

    // Then
    expect(found.results.map((r) => r.id)).toContain(written.id);
    expect(
      await sql("SELECT client, client_version, principal_id FROM sessions WHERE id = @id", {
        id: session_id,
      }),
    ).toEqual([{ client: "claude-code", client_version: "9.9.9", principal_id: "mac-claude" }]);
    expect(() => readdirSync(home)).toThrow();
  });

  it("should name the host when it refuses the token", async () => {
    // Given
    const file = join(dir, "forged");
    writeFileSync(file, "cbr_not-a-token-this-host-issued\n", { mode: 0o600 });
    const client = await plugin(file, join(dir, "home"));

    // When
    const res = (await client.callTool({ name: "session_start", arguments: {} })) as ToolResult;

    // Then
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain(`${url} refused this connection`);
  });
});
