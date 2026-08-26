import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  alwaysOnBlock,
  ANTIGRAVITY_PERMISSION_GRANTS,
  codexEnv,
  defaultEnv,
  discoverEnv,
  extractManagedBlock,
  hookScript,
  pending,
  piBridgeConfig,
  piExtension,
  piSettings,
  planHost,
  serverPath,
  skillPath,
  upsertManagedBlock,
  type HostId,
  type PlanInput,
  type Surface,
  type SurfaceStatus,
} from "@scripts/agent-hosts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

let home: string;

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    home,
    repoRoot: REPO,
    nodePath: process.execPath,
    env: defaultEnv(home, REPO),
    hasCommand: () => false,
    ...over,
  };
}

function status(host: HostId, surface: Surface): SurfaceStatus {
  const plan = planHost(host, input());
  return plan.surfaces.find((s) => s.surface === surface)!.status;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-setup-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("planHost", () => {
  it("should report every surface missing when the home is empty", () => {
    // Given / When
    const plan = planHost("claude", input());

    // Then
    expect(plan.detected).toBe(false);
    expect(plan.surfaces.map((s) => s.status)).toEqual([
      "missing",
      "missing",
      "missing",
      "missing",
    ]);
  });

  it("should detect a host from its config directory alone", () => {
    // Given
    mkdirSync(join(home, ".codex"), { recursive: true });

    // When / Then
    expect(planHost("codex", input()).detected).toBe(true);
  });

  it("should detect a host from its command when no config directory exists", () => {
    // Given / When
    const plan = planHost("claude", input({ hasCommand: (cmd) => cmd === "claude" }));

    // Then
    expect(plan.detected).toBe(true);
  });

  it("should detect a CLI-only Antigravity installation", () => {
    // Given
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });

    // When / Then
    expect(planHost("antigravity", input()).detected).toBe(true);
  });
});

describe("Skill surface", () => {
  it("should be ok when the skill is symlinked to the working tree", () => {
    // Given
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    symlinkSync(skillPath(REPO), join(home, ".claude", "skills", "cerebrium"));

    // When / Then
    expect(status("claude", "skill")).toBe("ok");
  });

  it("should be a conflict when the skill is a real directory", () => {
    // Given
    mkdirSync(join(home, ".claude", "skills", "cerebrium"), { recursive: true });

    // When / Then
    expect(status("claude", "skill")).toBe("conflict");
  });

  it("should be stale when the symlink points at another checkout", () => {
    // Given
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    symlinkSync(
      join(home, "elsewhere", "skill", "cerebrium"),
      join(home, ".claude", "skills", "cerebrium"),
    );

    // When / Then
    expect(status("claude", "skill")).toBe("stale");
  });

  it("should be ok when Antigravity declares the skill directory by path", () => {
    // Given
    writeJson(join(home, ".gemini", "config", "skills.json"), {
      entries: [{ path: join(REPO, "skill") }],
    });

    // When / Then
    expect(status("antigravity", "skill")).toBe("ok");
  });
});

describe("MCP surface", () => {
  it("should be ok when the registration launches this working tree's bundle", () => {
    // Given
    writeJson(join(home, ".claude.json"), {
      mcpServers: { cerebrium: { command: process.execPath, args: [serverPath(REPO)] } },
    });

    // When / Then
    expect(status("claude", "mcp")).toBe("ok");
  });

  it("should be stale when a bare node command makes the native ABI PATH-dependent", () => {
    // Given
    writeJson(join(home, ".claude.json"), {
      mcpServers: { cerebrium: { command: "node", args: [serverPath(REPO)] } },
    });

    // When / Then
    expect(status("claude", "mcp")).toBe("stale");
  });

  it("should be stale when the registration points at another path", () => {
    // Given
    writeJson(join(home, ".claude.json"), {
      mcpServers: { cerebrium: { command: "node", args: ["/opt/other/dist/server.js"] } },
    });

    // When / Then
    expect(status("claude", "mcp")).toBe("stale");
  });

  it("should be missing rather than throwing when mcp_config.json is empty", () => {
    // Given
    writeText(join(home, ".gemini", "config", "mcp_config.json"), "");

    // When / Then
    expect(status("antigravity", "mcp")).toBe("missing");
  });

  it("should report malformed host JSON as a conflict", () => {
    // Given
    writeText(join(home, ".gemini", "config", "mcp_config.json"), "{");

    // When / Then
    expect(status("antigravity", "mcp")).toBe("conflict");
  });

  it("should read Codex's registration out of the TOML text", () => {
    // Given
    writeText(
      join(home, ".codex", "config.toml"),
      `[mcp_servers.cerebrium]\ncommand = "${process.execPath}"\nargs = ["${serverPath(REPO)}"]\n`,
    );

    // When / Then
    expect(status("codex", "mcp")).toBe("ok");
  });

  it("should not accept Codex runtime and bundle values from another TOML table", () => {
    // Given
    writeText(
      join(home, ".codex", "config.toml"),
      `[mcp_servers.cerebrium]\ncommand = "node"\nargs = ["/old/server.js"]\n` +
        `[mcp_servers.other]\ncommand = "${process.execPath}"\nargs = ["${serverPath(REPO)}"]\n`,
    );

    // When / Then
    expect(status("codex", "mcp")).toBe("stale");
  });
});

describe("Rules surface", () => {
  it("should be ok when the managed block matches install/always-on.md", () => {
    // Given
    writeText(join(home, ".claude", "CLAUDE.md"), `# mine\n\n${alwaysOnBlock(REPO)}\n`);

    // When / Then
    expect(status("claude", "rules")).toBe("ok");
  });

  it("should be stale when the managed block has fallen behind", () => {
    // Given
    const outdated = alwaysOnBlock(REPO).replace("session_start", "start_session");
    writeText(join(home, ".claude", "CLAUDE.md"), outdated);

    // When / Then
    expect(status("claude", "rules")).toBe("stale");
  });

  it("should be missing when the file exists without a managed block", () => {
    // Given
    writeText(join(home, ".codex", "AGENTS.md"), "# my own rules\n");

    // When / Then
    expect(status("codex", "rules")).toBe("missing");
  });

  it("should use Antigravity's global GEMINI.md", () => {
    // Given
    writeText(join(home, ".gemini", "GEMINI.md"), alwaysOnBlock(REPO));

    // When / Then
    expect(status("antigravity", "rules")).toBe("ok");
  });

  it("should reject an unmatched managed-block marker", () => {
    // Given
    writeText(join(home, ".gemini", "GEMINI.md"), "mine\n<!-- cerebrium:start -->\n");

    // When / Then
    expect(status("antigravity", "rules")).toBe("conflict");
  });

  it.each([
    "<!-- cerebrium:start -->\na\n<!-- cerebrium:start -->\nb\n<!-- cerebrium:end -->",
    "<!-- cerebrium:start -->\na\n<!-- cerebrium:end -->\n<!-- cerebrium:end -->",
    "<!-- cerebrium:start -->\na\n<!-- cerebrium:end -->\n<!-- cerebrium:start -->\nb\n<!-- cerebrium:end -->",
  ])("should reject duplicate managed markers", (text) => {
    // Given
    writeText(join(home, ".gemini", "GEMINI.md"), text);

    // When / Then
    expect(status("antigravity", "rules")).toBe("conflict");
  });
});

describe("Antigravity permissions surface", () => {
  const appConfig = () => join(home, ".gemini", "config", "config.json");
  const cliConfig = () => join(home, ".gemini", "antigravity-cli", "settings.json");

  function appPermissions(allow: string[]): unknown {
    return { userSettings: { globalPermissionGrants: { allow } } };
  }

  function cliPermissions(allow: string[]): unknown {
    return { permissions: { allow } };
  }

  it("should accept an app-only installation", () => {
    // Given
    writeJson(appConfig(), appPermissions(ANTIGRAVITY_PERMISSION_GRANTS));

    // When / Then
    expect(status("antigravity", "permissions")).toBe("ok");
  });

  it("should accept a CLI-only installation", () => {
    // Given
    writeJson(cliConfig(), cliPermissions(ANTIGRAVITY_PERMISSION_GRANTS));

    // When / Then
    expect(status("antigravity", "permissions")).toBe("ok");
  });

  it("should require both configs to be complete when both are installed", () => {
    // Given
    writeJson(appConfig(), appPermissions(ANTIGRAVITY_PERMISSION_GRANTS));
    writeJson(cliConfig(), cliPermissions(["mcp(cerebrium/session_start)"]));

    // When / Then
    expect(status("antigravity", "permissions")).toBe("missing");
  });

  it("should ignore an absent CLI config when the CLI is not installed", () => {
    // Given
    writeJson(appConfig(), appPermissions(ANTIGRAVITY_PERMISSION_GRANTS));

    // When
    const plan = planHost("antigravity", input({ hasCommand: () => false }));

    // Then
    expect(plan.surfaces.find((surface) => surface.surface === "permissions")?.status).toBe("ok");
  });

  it("should report malformed permission shapes as conflicts", () => {
    // Given
    writeJson(appConfig(), { userSettings: { globalPermissionGrants: { allow: "all" } } });

    // When / Then
    expect(status("antigravity", "permissions")).toBe("conflict");
  });
});

describe("Hook surface", () => {
  it("should be ok when a hook entry points at the repository's hook script", () => {
    // Given
    writeJson(join(home, ".claude", "settings.json"), {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: `node ${hookScript(REPO)} --host claude` }] },
        ],
      },
    });

    // When / Then
    expect(status("claude", "hook")).toBe("ok");
  });

  it("should be missing when the settings file has other hooks only", () => {
    // Given
    writeJson(join(home, ".claude", "settings.json"), {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] },
    });

    // When / Then
    expect(status("claude", "hook")).toBe("missing");
  });
});

describe("Codex notes", () => {
  it("should call out the features flag when config.toml does not enable hooks", () => {
    // Given
    writeText(join(home, ".codex", "config.toml"), 'model = "gpt-5.5"\n');

    // When
    const plan = planHost("codex", input());

    // Then
    expect(plan.notes.some((n) => n.includes("hooks = true"))).toBe(true);
  });

  it("should not call out the features flag when hooks are already enabled", () => {
    // Given
    writeText(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");

    // When
    const plan = planHost("codex", input());

    // Then
    expect(plan.notes.some((n) => n.includes("hooks = true"))).toBe(false);
  });

  it("should always keep the trust-prompt note, which setup must not automate", () => {
    // Given / When
    const plan = planHost("codex", input());

    // Then
    expect(plan.notes.some((n) => n.includes("trust"))).toBe(true);
  });
});

describe("upsertManagedBlock", () => {
  it("should append the block when the file has none", () => {
    // Given / When
    const merged = upsertManagedBlock(
      "# mine\n",
      "<!-- cerebrium:start -->\nbody\n<!-- cerebrium:end -->",
    );

    // Then
    expect(merged).toBe("# mine\n\n<!-- cerebrium:start -->\nbody\n<!-- cerebrium:end -->\n");
  });

  it("should replace only the block and keep every other line", () => {
    // Given
    const text = "before\n\n<!-- cerebrium:start -->\nold\n<!-- cerebrium:end -->\n\nafter\n";

    // When
    const merged = upsertManagedBlock(
      text,
      "<!-- cerebrium:start -->\nnew\n<!-- cerebrium:end -->",
    );

    // Then
    expect(merged).toBe(
      "before\n\n<!-- cerebrium:start -->\nnew\n<!-- cerebrium:end -->\n\nafter\n",
    );
  });

  it("should be idempotent when applied twice", () => {
    // Given
    const block = "<!-- cerebrium:start -->\nbody\n<!-- cerebrium:end -->";

    // When
    const once = upsertManagedBlock("# mine\n", block);
    const twice = upsertManagedBlock(once, block);

    // Then
    expect(twice).toBe(once);
  });

  it("should extract nothing when the closing marker is absent", () => {
    // Given / When / Then
    expect(extractManagedBlock("<!-- cerebrium:start -->\nbody\n")).toBeNull();
  });

  it("should refuse to append around a malformed managed block", () => {
    // Given / When / Then
    expect(() =>
      upsertManagedBlock(
        "<!-- cerebrium:start -->\nbody\n",
        "<!-- cerebrium:start -->\nnew\n<!-- cerebrium:end -->",
      ),
    ).toThrow("malformed cerebrium managed block");
  });
});

describe("pi surfaces", () => {
  it("should report every surface missing on a home with no pi settings", () => {
    // Given / When
    const plan = planHost("pi", input());

    // Then
    expect(plan.surfaces.map((s) => s.surface)).toEqual([
      "extension",
      "mcp",
      "skill",
      "rules",
      "hook",
    ]);
    expect(plan.surfaces.every((s) => s.status === "missing")).toBe(true);
  });

  it("should be ok once settings.json declares this working tree's extension", () => {
    // Given
    writeJson(piSettings(home), { extensions: [piExtension(REPO)] });

    // When / Then
    expect(status("pi", "extension")).toBe("ok");
  });

  it("should be stale when the declared extension belongs to another checkout", () => {
    // Given
    writeJson(piSettings(home), {
      extensions: [join(home, "elsewhere", "install", "pi", "index.ts")],
    });

    // When / Then
    expect(status("pi", "extension")).toBe("stale");
  });

  it("should let skill, rules and the session hook follow the extension", () => {
    // Given
    writeJson(piSettings(home), { extensions: [piExtension(REPO)] });

    // When
    const plan = planHost("pi", input());

    // Then
    for (const surface of ["skill", "rules", "hook"] as const) {
      expect(plan.surfaces.find((s) => s.surface === surface)?.status).toBe("ok");
    }
  });

  it("should read the launch entry out of pi's own cerebrium.json", () => {
    // Given
    writeJson(piBridgeConfig(home), {
      command: process.execPath,
      args: [serverPath(REPO)],
      env: {},
    });

    // When / Then
    expect(status("pi", "mcp")).toBe("ok");
  });

  it("should be stale when the launch entry points at another bundle", () => {
    // Given
    writeJson(piBridgeConfig(home), { command: "node", args: ["/opt/other/dist/server.js"] });

    // When / Then
    expect(status("pi", "mcp")).toBe("stale");
  });

  it("should say plainly that pi has no MCP client of its own", () => {
    // Given / When
    const plan = planHost("pi", input());

    // Then
    expect(plan.notes.some((note) => note.includes("no MCP client"))).toBe(true);
  });
});

describe("discoverEnv", () => {
  it("should reuse the environment of an already registered host", () => {
    // Given
    writeJson(join(home, ".claude.json"), {
      mcpServers: {
        cerebrium: {
          command: "node",
          args: [serverPath(REPO)],
          env: { MEMORY_DB_PATH: "/db/m.db" },
        },
      },
    });

    // When / Then
    expect(discoverEnv(input())).toEqual({ MEMORY_DB_PATH: "/db/m.db" });
  });

  it("should fall back to Codex's TOML when no JSON host is registered", () => {
    // Given
    writeText(
      join(home, ".codex", "config.toml"),
      `[mcp_servers.cerebrium]\ncommand = "node"\nenv = { MEMORY_DB_PATH = "/db/m.db" }\n`,
    );

    // When / Then
    expect(discoverEnv(input())).toEqual({ MEMORY_DB_PATH: "/db/m.db" });
  });

  it("should fall back to pi's launch entry when it is the only registration", () => {
    // Given
    writeJson(piBridgeConfig(home), {
      command: process.execPath,
      args: [serverPath(REPO)],
      env: { MEMORY_DB_PATH: "/db/m.db" },
    });

    // When / Then
    expect(discoverEnv(input())).toEqual({ MEMORY_DB_PATH: "/db/m.db" });
  });

  it("should return null when nothing is registered anywhere", () => {
    // Given / When / Then
    expect(discoverEnv(input())).toBeNull();
  });
});

describe("codexEnv", () => {
  it("should read only the cerebrium table's env, not a later server's", () => {
    // Given
    const toml = `[mcp_servers.cerebrium]
command = "node"
env = { MEMORY_DB_PATH = "/db/m.db", MEMORY_CONSOLIDATE = "http" }

[mcp_servers.other]
env = { MEMORY_DB_PATH = "/db/other.db" }
`;

    // When / Then
    expect(codexEnv(toml)).toEqual({ MEMORY_DB_PATH: "/db/m.db", MEMORY_CONSOLIDATE: "http" });
  });
});

describe("pending", () => {
  it("should include Antigravity's global rules and permissions", () => {
    // Given
    const plan = planHost("antigravity", input());

    // When / Then
    expect(pending(plan).map((surface) => surface.surface)).toEqual([
      "mcp",
      "skill",
      "rules",
      "hook",
      "permissions",
    ]);
  });
});

describe("agent:setup exit status", () => {
  it("should abort before creating host config when the native preflight fails", () => {
    // Given
    const fakeRepo = join(home, "repo-without-native-addon");
    mkdirSync(fakeRepo, { recursive: true });
    writeText(join(fakeRepo, ".nvmrc"), `${process.versions.node.split(".")[0]}\n`);
    const viteNode = join(REPO, "node_modules", "vite-node", "vite-node.mjs");

    // When
    const result = spawnSync(
      process.execPath,
      [
        viteNode,
        "--config",
        join(REPO, "vitest.config.ts"),
        join(REPO, "scripts", "agent-setup.mts"),
        "--repo",
        fakeRepo,
        "--home",
        home,
        "--host",
        "antigravity",
        "--apply",
      ],
      { cwd: REPO, encoding: "utf8" },
    );

    // Then
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Runtime preflight failed");
    expect(existsSync(join(home, ".gemini"))).toBe(false);
  });

  it("should exit nonzero when an apply outcome fails", () => {
    // Given
    writeText(join(home, ".gemini", "config", "config.json"), "{");
    const viteNode = join(REPO, "node_modules", "vite-node", "vite-node.mjs");

    // When
    const result = spawnSync(
      process.execPath,
      [
        viteNode,
        "--config",
        join(REPO, "vitest.config.ts"),
        join(REPO, "scripts", "agent-setup.mts"),
        "--home",
        home,
        "--host",
        "antigravity",
        "--apply",
      ],
      { cwd: REPO, encoding: "utf8" },
    );

    // Then
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("config.json");
  });
});
