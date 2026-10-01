import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stableNodePath } from "@cerebrium/kernel/runtime/launch-agent";
import { applyHost, type ApplyOptions } from "@plugin/scripts/agent-apply";
import {
  codexServerEnv,
  kernelEnv,
  kernelProblems,
  piBridgeConfig,
  planHost,
  pluginServerPath,
  TRIAL_ENTRY,
  type PlanInput,
} from "@plugin/scripts/agent-hosts";

const REPO = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const URL = "tcp://100.64.0.1:7433";
const TOKEN = "cbr_secret-token-value-that-must-never-leak";

let home: string;
let tokenFile: string;
let ran: { cmd: string; args: string[] }[];

function input(): PlanInput {
  return {
    home,
    repoRoot: REPO,
    nodePath: process.execPath,
    env: kernelEnv(URL, tokenFile),
    hasCommand: () => true,
  };
}

function options(): ApplyOptions {
  return { force: false, run: (cmd, args) => ran.push({ cmd, args }) };
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function claudeJson(servers: Record<string, unknown>): void {
  writeText(join(home, ".claude.json"), JSON.stringify({ mcpServers: servers }, null, 2));
}

const LOCAL = {
  command: process.execPath,
  args: [join(REPO, "dist", "server.js")],
  env: { MEMORY_DB_PATH: "/Users/x/.cerebrium/memory.db" },
};

function hostBacked(): Record<string, unknown> {
  return {
    command: process.execPath,
    args: [pluginServerPath(REPO)],
    env: kernelEnv(URL, tokenFile),
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-host-backed-"));
  tokenFile = join(home, "host-token");
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  ran = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("A host-backed cerebrium entry", () => {
  it("should replace the local entry with the plugin bundle and only the URL and token path", () => {
    // Given
    claudeJson({ cerebrium: LOCAL });

    // When
    applyHost("claude", input(), options());

    // Then
    expect(ran).toEqual([
      { cmd: "claude", args: ["mcp", "remove", "cerebrium", "-s", "user"] },
      {
        cmd: "claude",
        args: [
          "mcp",
          "add",
          "cerebrium",
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
  });

  it("should remove the trial entry once the cerebrium entry is registered", () => {
    // Given
    claudeJson({ cerebrium: hostBacked(), [TRIAL_ENTRY]: hostBacked() });

    // When
    const planned = planHost("claude", input()).surfaces.find((s) => s.surface === "mcp");
    applyHost("claude", input(), options());

    // Then
    expect(planned).toMatchObject({
      status: "stale",
      detail: expect.stringContaining(TRIAL_ENTRY),
    });
    expect(ran.map((r) => r.args.slice(0, 3))).toEqual([
      ["mcp", "remove", "cerebrium"],
      ["mcp", "add", "cerebrium"],
      ["mcp", "remove", TRIAL_ENTRY],
    ]);
  });

  it("should leave a current entry alone", () => {
    // Given
    claudeJson({ cerebrium: hostBacked() });

    // When
    const planned = planHost("claude", input()).surfaces.find((s) => s.surface === "mcp");

    // Then
    expect(planned).toMatchObject({ status: "ok", detail: expect.stringContaining(URL) });
  });

  it("should call an entry naming another host stale", () => {
    // Given
    claudeJson({ cerebrium: { ...hostBacked(), env: kernelEnv("tcp://old:1", tokenFile) } });

    // When
    const planned = planHost("claude", input()).surfaces.find((s) => s.surface === "mcp");

    // Then
    expect(planned?.status).toBe("stale");
  });

  it("should never carry the token itself", () => {
    // Given
    claudeJson({ cerebrium: LOCAL });

    // When
    for (const host of ["claude", "codex", "antigravity", "pi"] as const) {
      applyHost(host, input(), options());
    }

    // Then
    expect(JSON.stringify(ran)).not.toContain(TOKEN);
    expect(readFileSync(piBridgeConfig(home), "utf8")).not.toContain(TOKEN);
    expect(readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8")).not.toContain(
      TOKEN,
    );
  });

  it("should write the plugin bundle into Antigravity's and pi's launch entries", () => {
    // When
    applyHost("antigravity", input(), options());
    applyHost("pi", input(), options());
    const antigravity = JSON.parse(
      readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8"),
    ) as { mcpServers: { cerebrium: unknown } };
    const pi = JSON.parse(readFileSync(piBridgeConfig(home), "utf8")) as unknown;

    // Then
    expect(antigravity.mcpServers.cerebrium).toEqual(hostBacked());
    expect(pi).toEqual(hostBacked());
  });

  it("should read Codex's entry with its env subtable", () => {
    // Given
    const toml = [
      "[mcp_servers.cerebrium]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = ${JSON.stringify([pluginServerPath(REPO)])}`,
      "",
      "[mcp_servers.cerebrium.env]",
      `MEMORY_KERNEL_URL = "${URL}"`,
      `MEMORY_KERNEL_TOKEN_FILE = "${tokenFile}"`,
      "",
    ].join("\n");
    writeText(join(home, ".codex", "config.toml"), toml);

    // When
    const planned = planHost("codex", input()).surfaces.find((s) => s.surface === "mcp");

    // Then
    expect(codexServerEnv(toml, "cerebrium")).toEqual(kernelEnv(URL, tokenFile));
    expect(planned?.status).toBe("ok");
  });

  it("should refuse a token file others can read, a missing one and a non-tcp URL", () => {
    // Given
    const loose = join(home, "loose-token");
    writeFileSync(loose, "x", { mode: 0o644 });

    // When
    const problems = [
      ...kernelProblems(URL, loose),
      ...kernelProblems(URL, join(home, "absent")),
      ...kernelProblems("/tmp/daemon.sock", tokenFile),
    ];

    // Then
    expect(problems).toEqual([
      expect.stringContaining("is readable by others (mode 644)"),
      expect.stringContaining("does not exist"),
      expect.stringContaining("is not a tcp://host:port URL"),
    ]);
    expect(kernelProblems(URL, tokenFile)).toEqual([]);
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

  it("should report the host env on a stable Node path without printing the token", () => {
    // When
    const result = setup("--kernel", URL, "--token-file", tokenFile);

    // Then
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`MEMORY_KERNEL_URL=${URL}`);
    expect(result.stdout).toContain(
      `Node runtime: ${stableNodePath(realpathSync(process.execPath))}`,
    );
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
  });

  it("should keep the host it finds registered when run without the flags", () => {
    // Given
    claudeJson({ cerebrium: hostBacked() });

    // When
    const result = setup();

    // Then
    expect(result.stdout).toContain("reused from an existing registration");
    expect(result.stdout).toContain(`MEMORY_KERNEL_URL=${URL}`);
  });

  it("should refuse --kernel without --token-file", () => {
    // When
    const result = setup("--kernel", URL);

    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("go together");
  });
});
