import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  alwaysOnBlock,
  codexEnv,
  defaultEnv,
  discoverEnv,
  extractManagedBlock,
  hookScript,
  pending,
  planHost,
  serverPath,
  skillPath,
  upsertManagedBlock,
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
    env: defaultEnv(home, REPO),
    hasCommand: () => false,
    ...over,
  };
}

function status(host: "claude" | "codex" | "antigravity", surface: Surface): SurfaceStatus {
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
      mcpServers: { cerebrium: { command: "node", args: [serverPath(REPO)] } },
    });

    // When / Then
    expect(status("claude", "mcp")).toBe("ok");
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

  it("should read Codex's registration out of the TOML text", () => {
    // Given
    writeText(
      join(home, ".codex", "config.toml"),
      `[mcp_servers.cerebrium]\ncommand = "node"\nargs = ["${serverPath(REPO)}"]\n`,
    );

    // When / Then
    expect(status("codex", "mcp")).toBe("ok");
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

  it("should stay manual for Antigravity, which has no machine-wide rules file", () => {
    // Given / When / Then
    expect(status("antigravity", "rules")).toBe("manual");
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
env = { MEMORY_DB_PATH = "/db/m.db", MEMORY_RERANK = "local" }

[mcp_servers.other]
env = { MEMORY_DB_PATH = "/db/other.db" }
`;

    // When / Then
    expect(codexEnv(toml)).toEqual({ MEMORY_DB_PATH: "/db/m.db", MEMORY_RERANK: "local" });
  });
});

describe("pending", () => {
  it("should exclude surfaces that cannot be automated", () => {
    // Given
    const plan = planHost("antigravity", input());

    // When / Then
    expect(pending(plan).some((s) => s.surface === "rules")).toBe(false);
  });
});
