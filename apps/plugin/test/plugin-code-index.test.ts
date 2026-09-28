import "reflect-metadata";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { NODES_REPO_TOKEN } from "@cerebrium/kernel/domain/ports/storage";
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
import { pluginBundle, runToExit } from "./plugin-bundle";

const UTIL = `export function hashToken(input: string): string {
  return input.split("").reverse().join("");
}
`;
const AUTH = `import { hashToken } from "./util";

export class AuthService {
  validate(pw: string): boolean {
    return hashToken(pw).length > 0;
  }
}
`;

let daemon: DependencyContainer;
let rpc: RpcServer;
let url: string;
let dir: string;
let repo: string;
let token: string;
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
    ...createDaemonMethods(daemon, { pid: process.pid, model: () => null }),
  });

  const { port } = await rpc.listenTcp("127.0.0.1", 0, {
    authenticate: (t) => tokens.authenticate(t),
    methods: networkMethods(),
  });

  url = `tcp://127.0.0.1:${String(port)}`;
}

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function put(rel: string, body: string): void {
  mkdirSync(join(repo, rel, ".."), { recursive: true });
  writeFileSync(join(repo, rel), body);
}

function commit(message: string): void {
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", message);
}

async function plugin(): Promise<Client> {
  const { server } = await pluginBundle();
  const client = new Client({ name: "claude-code", version: "9.9.9" });

  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [server],
      cwd: repo,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: dir,
        CEREBRIUM_HOME: join(dir, "home"),
        MEMORY_KERNEL_URL: url,
        MEMORY_KERNEL_TOKEN_FILE: token,
      },
      stderr: "ignore",
    }),
  );
  clients.push(client);

  return client;
}

function payload<T>(res: unknown): T {
  const r = res as { isError?: boolean; content: { text: string }[] };

  if (r.isError) throw new Error(`tool returned isError: ${r.content[0]?.text ?? ""}`);

  return JSON.parse(r.content[0]!.text) as T;
}

async function sql<T>(text: string): Promise<T[]> {
  return (await daemon.resolve<PgDatabase>(PG_TOKEN).query(text)).rows as T[];
}

interface Lookup {
  symbols: { id: string; title: string; branch?: string }[];
  notes?: string[];
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "cb-plugin-code-"));
  repo = join(dir, "widgets");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "https://github.com/Acme/Widgets.git");
  put("src/util.ts", UTIL);
  put("src/auth.ts", AUTH);
  put("node_modules/dep/index.js", "export const x = 1;\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  commit("init");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

  await startHost();

  const issued = await daemon.resolve(PrincipalTokenService).issue("mac-claude", "code-e2e");

  token = join(dir, "token");
  writeFileSync(token, `${issued.token}\n`, { mode: 0o600 });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await rpc.close();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(TEST_BACKEND !== "postgres")("Code indexing through the plugin bundle", () => {
  it("should upload the checkout, let the host parse it, and read it back on each branch", async () => {
    // Given
    const main = await plugin();
    const { session_id } = payload<{ session_id: string }>(
      await main.callTool({ name: "session_start", arguments: { project: "widgets" } }),
    );

    // When
    const indexed = payload<{ repo: string; branch: string; files_scanned: number }>(
      await main.callTool({ name: "code_index", arguments: { session_id } }),
    );
    const onMain = payload<Lookup>(
      await main.callTool({ name: "code_lookup", arguments: { session_id, name: "hashToken" } }),
    );

    git("checkout", "-q", "-b", "feature");
    put(
      "src/util.ts",
      `${UTIL}\nexport function saltToken(input: string): string {\n  return hashToken(input) + "!";\n}\n`,
    );
    commit("salt");

    const feature = await plugin();

    payload(await feature.callTool({ name: "code_index", arguments: { session_id } }));

    const saltOnFeature = payload<Lookup>(
      await feature.callTool({ name: "code_lookup", arguments: { session_id, name: "saltToken" } }),
    );
    const saltOnMain = payload<Lookup>(
      await feature.callTool({
        name: "code_lookup",
        arguments: { session_id, name: "saltToken", branch: "main" },
      }),
    );

    // Then
    expect(indexed).toMatchObject({ repo: "widgets", branch: "main", files_scanned: 2 });
    expect(onMain.symbols.map((s) => [s.title, s.branch])).toEqual([
      ["src/util.ts:hashToken", "main"],
    ]);
    expect(saltOnFeature.symbols.map((s) => s.branch)).toEqual(["feature"]);
    expect(saltOnMain.symbols).toEqual([]);
    expect(await sql("SELECT remote_key, default_branch FROM code_repos")).toEqual([
      { remote_key: "github.com/acme/widgets", default_branch: "main" },
    ]);
    expect(await sql("SELECT COUNT(*)::int AS c FROM code_blobs")).toEqual([{ c: 3 }]);
  });

  it("should follow a note's link into the code of the branch the session is on", async () => {
    // Given
    const client = await plugin();
    const { session_id } = payload<{ session_id: string }>(
      await client.callTool({ name: "session_start", arguments: { project: "widgets" } }),
    );

    payload(await client.callTool({ name: "code_index", arguments: { session_id } }));

    const [hash] = payload<Lookup>(
      await client.callTool({ name: "code_lookup", arguments: { session_id, name: "hashToken" } }),
    ).symbols;
    const written = payload<{ id: string }>(
      await client.callTool({
        name: "write",
        arguments: {
          session_id,
          parent_node_id: null,
          memory_kind: MemoryKind.SEMANTIC,
          type: "fact",
          title: "Token reversal gotcha",
          content: "the token helper only reverses its input and is no real digest",
          project: "widgets",
          links: [{ dst: hash!.id, type: "documents" }],
        },
      }),
    );

    // When
    const found = payload<{ results: { id: string; via?: { node: string } }[] }>(
      await client.callTool({
        name: "search",
        arguments: { session_id, query: "token helper reverses input digest" },
      }),
    );

    // Then
    expect(found.results.find((r) => r.id === hash!.id)?.via?.node).toBe(written.id);
  });

  it("should split an upload of many small files into frames the host accepts", async () => {
    // Given
    for (let i = 0; i < 520; i++)
      put(`src/many/f${String(i)}.ts`, `export const v${String(i)} = ${String(i)};\n`);
    commit("many");
    const { index } = await pluginBundle();

    // When
    const exited = await runToExit(
      index,
      {
        HOME: dir,
        CEREBRIUM_HOME: join(dir, "home"),
        MEMORY_KERNEL_URL: url,
        MEMORY_KERNEL_TOKEN_FILE: token,
      },
      [repo],
    );

    // Then
    expect(exited.stderr).toBe("");
    expect(exited.code).toBe(0);
    expect(await sql("SELECT COUNT(*)::int AS c FROM code_branch_files")).toEqual([{ c: 522 }]);
  });

  it("should index a checkout from the command line, as the git hooks do", async () => {
    // Given
    const { index } = await pluginBundle();

    // When
    const exited = await runToExit(
      index,
      {
        HOME: dir,
        CEREBRIUM_HOME: join(dir, "home"),
        MEMORY_KERNEL_URL: url,
        MEMORY_KERNEL_TOKEN_FILE: token,
      },
      [repo],
    );

    // Then
    expect(exited.code).toBe(0);
    expect(
      await sql("SELECT branch, commit_sha IS NOT NULL AS has_commit FROM code_branches"),
    ).toEqual([{ branch: "main", has_commit: true }]);
  });
});
