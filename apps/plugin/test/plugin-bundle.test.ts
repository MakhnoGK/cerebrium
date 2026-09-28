import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pluginBundle, runToExit } from "./plugin-bundle";

const FORBIDDEN_PACKAGES = [
  "better-sqlite3",
  "sqlite-vec",
  "pg",
  "pg-pool",
  "@huggingface/transformers",
  "onnxruntime-node",
  "onnxruntime-web",
  "web-tree-sitter",
  "tree-sitter-wasms",
];
const FORBIDDEN_KERNEL_DIRS = [
  "packages/kernel/src/db/",
  "packages/kernel/src/embeddings/",
  "packages/kernel/src/code/",
  "packages/kernel/src/application/use-cases/local",
];
const BUILTINS = new Set(builtinModules);

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "cb-plugin-run-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function packageOf(input: string): string | null {
  const at = input.lastIndexOf("node_modules/");

  if (at < 0) return null;

  const parts = input.slice(at + "node_modules/".length).split("/");

  return parts[0]!.startsWith("@") ? `${parts[0]!}/${parts[1]!}` : parts[0]!;
}

describe("The plugin bundle", () => {
  it("should import nothing but node builtins", async () => {
    // Given
    const { metafile } = await pluginBundle();

    // When
    const external = Object.values(metafile.outputs)
      .flatMap((out) => out.imports)
      .filter((i) => i.external)
      .map((i) => i.path);

    // Then
    expect(external.filter((path) => !BUILTINS.has(path.replace(/^node:/, "")))).toEqual([]);
  });

  it("should carry no storage backend, model runtime or parser", async () => {
    // Given
    const { metafile } = await pluginBundle();
    const inputs = Object.keys(metafile.inputs);

    // When
    const packages = inputs.map(packageOf).filter((name) => name !== null);
    const kernel = inputs.filter((path) => FORBIDDEN_KERNEL_DIRS.some((dir) => path.includes(dir)));

    // Then
    expect(packages.filter((name) => FORBIDDEN_PACKAGES.includes(name))).toEqual([]);
    expect(kernel).toEqual([]);
  });

  it("should refuse to start without a kernel URL, naming the variable", async () => {
    // Given
    const { server } = await pluginBundle();
    const home = join(scratch, "home");

    // When
    const exited = await runToExit(server, { CEREBRIUM_HOME: home });

    // Then
    expect(exited.code).toBe(1);
    expect(exited.stderr).toContain("MEMORY_KERNEL_URL is not set");
    expect(() => readdirSync(home)).toThrow();
  });

  it("should name the host's URL when it cannot reach it, and create nothing locally", async () => {
    // Given
    const { server } = await pluginBundle();
    const home = join(scratch, "home");
    const tokenFile = join(scratch, "token");
    writeFileSync(tokenFile, "cbr_unused\n", { mode: 0o600 });
    const client = new Client({ name: "claude-code", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [server],
        env: {
          PATH: process.env.PATH ?? "",
          CEREBRIUM_HOME: home,
          MEMORY_KERNEL_URL: "tcp://127.0.0.1:1",
          MEMORY_KERNEL_TOKEN_FILE: tokenFile,
        },
        stderr: "ignore",
      }),
    );

    try {
      // When
      const tools = await client.listTools();
      const res = (await client.callTool({ name: "session_start", arguments: {} })) as {
        isError?: boolean;
        content: { text: string }[];
      };

      // Then
      expect(tools.tools.map((t) => t.name)).toContain("session_start");
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toMatch(
        /could not reach the Cerebrium host at tcp:\/\/127\.0\.0\.1:1 for start_session/,
      );
      expect(res.content[0]!.text).toContain("Nothing was sent");
      expect(() => readdirSync(home)).toThrow();
    } finally {
      await client.close();
    }
  });
});
