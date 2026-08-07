import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyHost, type ApplyOptions } from "@scripts/agent-apply";
import {
  defaultEnv,
  pending,
  planHost,
  skillPath,
  type HostId,
  type PlanInput,
} from "@scripts/agent-hosts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

let home: string;
let ran: { cmd: string; args: string[] }[];

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    home,
    repoRoot: REPO,
    env: { MEMORY_DB_PATH: join(home, ".cerebrium", "memory.db") },
    hasCommand: () => true,
    ...over,
  };
}

function options(over: Partial<ApplyOptions> = {}): ApplyOptions {
  return {
    force: false,
    run: (cmd, args) => ran.push({ cmd, args }),
    ...over,
  };
}

function outstanding(host: HostId): string[] {
  return pending(planHost(host, input())).map((s) => s.surface);
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-apply-"));
  ran = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("applyHost", () => {
  it("should leave nothing outstanding for a host it can fully wire up", () => {
    // Given
    expect(outstanding("antigravity")).toEqual(["mcp", "skill", "hook"]);

    // When
    applyHost("antigravity", input(), options());

    // Then
    expect(outstanding("antigravity")).toEqual([]);
  });

  it("should be a no-op on a second run", () => {
    // Given
    applyHost("antigravity", input(), options());
    const before = read(join(home, ".gemini", "config", "skills.json"));

    // When
    const second = applyHost("antigravity", input(), options());

    // Then
    expect(second).toEqual([]);
    expect(read(join(home, ".gemini", "config", "skills.json"))).toBe(before);
  });

  it("should register the MCP server through the host's own CLI", () => {
    // Given / When
    applyHost("codex", input(), options());

    // Then
    const add = ran.find((r) => r.args[1] === "add")!;
    expect(add.cmd).toBe("codex");
    expect(add.args).toContain("--env");
    expect(add.args.at(-1)).toBe(join(REPO, "dist", "server.js"));
  });

  it("should remove a stale registration before adding the new one", () => {
    // Given
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { cerebrium: { command: "node", args: ["/opt/old/server.js"] } },
      }),
    );

    // When
    applyHost("claude", input(), options());

    // Then
    expect(ran.map((r) => r.args[1])).toEqual(["remove", "add"]);
  });

  it("should skip registration when the host's CLI is not on PATH", () => {
    // Given / When
    const applied = applyHost("codex", input({ hasCommand: () => false }), options());

    // Then
    expect(applied.find((a) => a.surface === "mcp")?.outcome).toBe("skipped");
    expect(ran).toEqual([]);
  });
});

describe("Rules block", () => {
  it("should keep every line the user wrote around it", () => {
    // Given
    const path = join(home, ".codex", "AGENTS.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "# my own rules\n\nnever force-push\n");

    // When
    applyHost("codex", input(), options());

    // Then
    const after = read(path);
    expect(after).toContain("# my own rules");
    expect(after).toContain("never force-push");
    expect(after).toContain("<!-- cerebrium:start");
  });

  it("should replace a stale block in place rather than appending a second one", () => {
    // Given
    applyHost("codex", input(), options());
    const path = join(home, ".codex", "AGENTS.md");
    writeFileSync(path, read(path).replace("session_start", "start_session"));

    // When
    applyHost("codex", input(), options());

    // Then
    const after = read(path);
    expect(after.match(/<!-- cerebrium:start/g)).toHaveLength(1);
    expect(after).not.toContain("start_session");
  });
});

describe("Skill link", () => {
  it("should link the skill to the working tree", () => {
    // Given / When
    applyHost("claude", input(), options());

    // Then
    const link = join(home, ".claude", "skills", "cerebrium");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(read(join(link, "SKILL.md"))).toContain("cerebrium — usage discipline");
  });

  it("should refuse to touch an existing copy without --force", () => {
    // Given
    const link = join(home, ".claude", "skills", "cerebrium");
    mkdirSync(link, { recursive: true });

    // When
    const applied = applyHost("claude", input(), options());

    // Then
    expect(applied.find((a) => a.surface === "skill")?.outcome).toBe("skipped");
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
  });

  it("should move a copy aside rather than delete it when forced", () => {
    // Given
    const link = join(home, ".claude", "skills", "cerebrium");
    mkdirSync(link, { recursive: true });
    writeFileSync(join(link, "SKILL.md"), "hand-edited");

    // When
    const applied = applyHost("claude", input(), options({ force: true }));

    // Then
    const aside = /kept at ([^)]+)\)/.exec(applied.find((a) => a.surface === "skill")!.detail)![1]!;
    expect(read(join(aside, "SKILL.md"))).toBe("hand-edited");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("should repoint a symlink that leads to another checkout", () => {
    // Given
    const link = join(home, ".claude", "skills", "cerebrium");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(home, "another-checkout", "skill", "cerebrium"), link);

    // When
    applyHost("claude", input(), options());

    // Then
    expect(existsSync(join(link, "SKILL.md"))).toBe(true);
    expect(outstanding("claude")).not.toContain("skill");
  });
});

describe("Hooks", () => {
  it("should keep a host's unrelated hooks", () => {
    // Given
    const path = join(home, ".claude", "settings.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [] }] } }));

    // When
    applyHost("claude", input(), options());

    // Then
    const after = JSON.parse(read(path));
    expect(after.model).toBe("opus");
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.SessionStart).toHaveLength(1);
  });

  it("should not stack duplicate entries across runs", () => {
    // Given
    applyHost("claude", input(), options());
    const path = join(home, ".claude", "settings.json");
    const settings = JSON.parse(read(path));
    settings.hooks.SessionStart[0].hooks[0].timeout = 99;
    writeFileSync(path, JSON.stringify(settings));

    // When
    applyHost("claude", input(), options());

    // Then
    expect(JSON.parse(read(path)).hooks.SessionStart).toHaveLength(1);
  });

  it("should use Antigravity's PreInvocation shape, not Claude's", () => {
    // Given / When
    applyHost("antigravity", input(), options());

    // Then
    const hooks = JSON.parse(read(join(home, ".gemini", "config", "hooks.json")));
    expect(hooks.cerebrium.PreInvocation[0].command).toContain("--host antigravity");
  });
});

describe("Environment", () => {
  it("should point Antigravity at the same store the caller resolved", () => {
    // Given / When
    applyHost("antigravity", input(), options());

    // Then
    const config = JSON.parse(read(join(home, ".gemini", "config", "mcp_config.json")));
    expect(config.mcpServers.cerebrium.env.MEMORY_DB_PATH).toBe(
      join(home, ".cerebrium", "memory.db"),
    );
    expect(config.mcpServers.cerebrium.args).toEqual([join(REPO, "dist", "server.js")]);
  });

  it("should default the store under the inspected home when nothing is registered", () => {
    // Given / When
    const env = defaultEnv(home, REPO);

    // Then
    expect(env.MEMORY_DB_PATH).toBe(join(home, ".cerebrium", "memory.db"));
    expect(env.MEMORY_CODE_ROOTS).toBe(`cerebrium=${REPO}`);
  });
});

describe("Skill path", () => {
  it("should resolve to the skill the hosts read", () => {
    // Given / When / Then
    expect(existsSync(join(skillPath(REPO), "SKILL.md"))).toBe(true);
  });
});
