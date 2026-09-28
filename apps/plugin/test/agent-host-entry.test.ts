import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stableNodePath } from "@cerebrium/kernel/runtime/launch-agent";
import type { ApplyOptions } from "@plugin/scripts/agent-apply";
import {
  applyHostEntry,
  codexServerEnv,
  HOST_ENTRY,
  hostEntryProblems,
  planHostEntry,
  pluginServerPath,
  type HostEntryInput,
} from "@plugin/scripts/agent-host-entry";

const REPO = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const URL = "tcp://100.64.0.1:7433";
const TOKEN = "cbr_secret-token-value-that-must-never-leak";

let home: string;
let tokenFile: string;
let ran: { cmd: string; args: string[] }[];

function input(over: Partial<HostEntryInput> = {}): HostEntryInput {
  return {
    home,
    repoRoot: REPO,
    nodePath: process.execPath,
    kernelUrl: URL,
    tokenFile,
    hasCommand: () => true,
    ...over,
  };
}

function options(): ApplyOptions {
  return { force: false, run: (cmd, args) => ran.push({ cmd, args }) };
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function claudeJson(servers: Record<string, unknown>): string {
  const path = join(home, ".claude.json");
  writeText(path, JSON.stringify({ mcpServers: servers }, null, 2));
  return path;
}

const CEREBRIUM = {
  command: process.execPath,
  args: [join(REPO, "dist", "server.js")],
  env: { MEMORY_DB_PATH: "/Users/x/.cerebrium/memory.db" },
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-host-entry-"));
  tokenFile = join(home, "host-token");
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  ran = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("The cerebrium-host entry", () => {
  it("should register a separate server that runs the plugin bundle with only the URL and the token path", () => {
    // Given
    const path = claudeJson({ cerebrium: CEREBRIUM });
    const before = readFileSync(path, "utf8");

    // When
    const applied = applyHostEntry("claude", input(), options());

    // Then
    expect(applied.outcome).toBe("created");
    expect(ran).toEqual([
      {
        cmd: "claude",
        args: [
          "mcp",
          "add",
          HOST_ENTRY,
          "-s",
          "user",
          "--env",
          `MEMORY_KERNEL_URL=${URL}`,
          "--env",
          `MEMORY_KERNEL_TOKEN_FILE=${tokenFile}`,
          "--",
          process.execPath,
          pluginServerPath(REPO),
        ],
      },
    ]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("should never carry the token itself", () => {
    // Given
    claudeJson({});

    // When
    applyHostEntry("claude", input(), options());
    applyHostEntry("codex", input(), options());

    // Then
    expect(JSON.stringify(ran)).not.toContain(TOKEN);
  });

  it("should replace a stale cerebrium-host entry without touching cerebrium", () => {
    // Given
    claudeJson({
      cerebrium: CEREBRIUM,
      [HOST_ENTRY]: { ...CEREBRIUM, env: { MEMORY_KERNEL_URL: "tcp://old:1" } },
    });

    // When
    const applied = applyHostEntry("claude", input(), options());

    // Then
    expect(applied.outcome).toBe("updated");
    expect(ran.map((r) => r.args.slice(0, 3))).toEqual([
      ["mcp", "remove", HOST_ENTRY],
      ["mcp", "add", HOST_ENTRY],
    ]);
  });

  it("should leave a current entry alone", () => {
    // Given
    claudeJson({
      [HOST_ENTRY]: {
        command: process.execPath,
        args: [pluginServerPath(REPO)],
        env: { MEMORY_KERNEL_URL: URL, MEMORY_KERNEL_TOKEN_FILE: tokenFile },
      },
    });

    // When
    const applied = applyHostEntry("claude", input(), options());

    // Then
    expect(applied.outcome).toBe("unchanged");
    expect(ran).toEqual([]);
  });

  it("should read Codex's entry with its env subtable", () => {
    // Given
    const toml = [
      "[mcp_servers.cerebrium]",
      `command = ${JSON.stringify(process.execPath)}`,
      "",
      `  [mcp_servers.${HOST_ENTRY}]`,
      `    command = ${JSON.stringify(process.execPath)}`,
      `    args = ${JSON.stringify([pluginServerPath(REPO)])}`,
      "",
      `    [mcp_servers.${HOST_ENTRY}.env]`,
      `      MEMORY_KERNEL_URL = "${URL}"`,
      `      MEMORY_KERNEL_TOKEN_FILE = "${tokenFile}"`,
      "",
    ].join("\n");
    writeText(join(home, ".codex", "config.toml"), toml);

    // When
    const planned = planHostEntry("codex", input());

    // Then
    expect(codexServerEnv(toml, HOST_ENTRY)).toEqual({
      MEMORY_KERNEL_URL: URL,
      MEMORY_KERNEL_TOKEN_FILE: tokenFile,
    });
    expect(planned.status).toBe("ok");
  });

  it("should refuse a token file others can read, a missing one and a non-tcp URL", () => {
    // Given
    const loose = join(home, "loose-token");
    writeFileSync(loose, "x", { mode: 0o644 });

    // When
    const problems = [
      ...hostEntryProblems(input({ tokenFile: loose })),
      ...hostEntryProblems(input({ tokenFile: join(home, "absent") })),
      ...hostEntryProblems(input({ kernelUrl: "/tmp/daemon.sock" })),
    ];

    // Then
    expect(problems).toEqual([
      expect.stringContaining("is readable by others (mode 644)"),
      expect.stringContaining("does not exist"),
      expect.stringContaining("is not a tcp://host:port URL"),
    ]);
    expect(hostEntryProblems(input())).toEqual([]);
  });
});

describe("agent:setup --kernel", () => {
  function setup(...args: string[]) {
    return spawnSync(
      process.execPath,
      [
        join(REPO, "node_modules", "vite-node", "vite-node.mjs"),
        "--config",
        join(REPO, "vitest.config.ts"),
        join(REPO, "apps", "plugin", "scripts", "agent-setup.mts"),
        "--home",
        home,
        ...args,
      ],
      { cwd: REPO, encoding: "utf8" },
    );
  }

  it("should report the entry without printing the token", () => {
    // When
    const result = setup("--kernel", URL, "--token-file", tokenFile);

    // Then
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${HOST_ENTRY} -> ${URL}`);
    expect(result.stdout).toContain(`node ${stableNodePath(realpathSync(process.execPath))})`);
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
  });

  it("should refuse a host the trial entry does not cover", () => {
    // When
    const result = setup("--kernel", URL, "--token-file", tokenFile, "--host", "pi");

    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("claude and codex only");
  });
});
