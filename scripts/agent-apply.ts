import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  alwaysOnBlock,
  desiredMcp,
  hookCommand,
  hookScript,
  pending,
  planHost,
  serverPath,
  skillPath,
  upsertManagedBlock,
  type HostId,
  type PlanInput,
  type Surface,
  type SurfaceState,
} from "@scripts/agent-hosts";

// Writes what the planner found missing. Every surface goes through the plan first, so
// "what is missing" and "what gets written" cannot disagree. Nothing here touches the
// database, and nothing is deleted: a skill directory in the way is moved aside, never
// removed.

export type Outcome = "created" | "updated" | "unchanged" | "skipped" | "failed";

export interface Applied {
  surface: Surface;
  outcome: Outcome;
  detail: string;
}

export interface ApplyOptions {
  force: boolean;
  run: (cmd: string, args: string[]) => void;
}

function done(surface: Surface, outcome: Outcome, detail: string): Applied {
  return { surface, outcome, detail };
}

function readJson(path: string): Record<string, unknown> {
  try {
    const raw = readFileSync(path, "utf8").trim();
    return raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return {};
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function envFlags(env: Record<string, string>, flag: string): string[] {
  return Object.entries(env).flatMap(([k, v]) => [flag, `${k}=${v}`]);
}

function ensureSymlink(link: string, target: string, force: boolean): Applied {
  const state = statusOf(link);
  if (state === "missing") {
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link);
    return done("skill", "created", `${link} -> ${target}`);
  }
  if (state === "link") {
    unlinkSync(link);
    symlinkSync(target, link);
    return done("skill", "updated", `${link} -> ${target}`);
  }
  if (!force) {
    return done(
      "skill",
      "skipped",
      `${link} is a real directory — a copy that drifts. Re-run with --force to move it aside.`,
    );
  }
  const aside = `${link}.copy-${Date.now()}`;
  renameSync(link, aside);
  symlinkSync(target, link);
  return done("skill", "updated", `${link} -> ${target} (previous copy kept at ${aside})`);
}

function statusOf(link: string): "missing" | "link" | "path" {
  try {
    return lstatSync(link).isSymbolicLink() ? "link" : "path";
  } catch {
    return "missing";
  }
}

function writeRules(path: string, repoRoot: string): Applied {
  const before = ((): string => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  })();
  const after = upsertManagedBlock(before, alwaysOnBlock(repoRoot));
  if (after === before) return done("rules", "unchanged", path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, after);
  return done("rules", before === "" ? "created" : "updated", path);
}

/** Drops any group that already points at our hook script, so a re-run cannot stack them. */
function withoutOurs(groups: unknown, repoRoot: string): unknown[] {
  return Array.isArray(groups)
    ? groups.filter((g) => !JSON.stringify(g).includes(hookScript(repoRoot)))
    : [];
}

function writeClaudeHook(path: string, repoRoot: string): Applied {
  const settings = readJson(path);
  const hooks = record(settings.hooks);
  hooks.SessionStart = [
    ...withoutOurs(hooks.SessionStart, repoRoot),
    {
      matcher: "",
      hooks: [{ type: "command", command: hookCommand(repoRoot, "claude"), timeout: 5 }],
    },
  ];
  settings.hooks = hooks;
  writeJson(path, settings);
  return done("hook", "updated", path);
}

function writeCodexHook(path: string, repoRoot: string): Applied {
  const file = readJson(path);
  const hooks = record(file.hooks);
  hooks.SessionStart = [
    ...withoutOurs(hooks.SessionStart, repoRoot),
    { hooks: [{ type: "command", command: hookCommand(repoRoot, "codex"), timeout: 5 }] },
  ];
  file.hooks = hooks;
  writeJson(path, file);
  return done("hook", "updated", path);
}

function writeAntigravityHook(path: string, repoRoot: string): Applied {
  const file = readJson(path);
  file.cerebrium = {
    PreInvocation: [
      { type: "command", command: hookCommand(repoRoot, "antigravity"), timeout: 10 },
    ],
  };
  writeJson(path, file);
  return done("hook", "updated", path);
}

function registerViaCli(
  cli: string,
  extra: string[],
  input: PlanInput,
  opts: ApplyOptions,
  stale: boolean,
  envFlag: string,
): Applied {
  if (!input.hasCommand(cli)) {
    return done("mcp", "skipped", `${cli} is not on PATH — register it from a machine that has it`);
  }
  try {
    if (stale) opts.run(cli, ["mcp", "remove", "cerebrium", ...extra]);
    opts.run(cli, [
      "mcp",
      "add",
      "cerebrium",
      ...extra,
      ...envFlags(input.env, envFlag),
      "--",
      "node",
      serverPath(input.repoRoot),
    ]);
  } catch (err) {
    return done("mcp", "failed", `${cli} mcp add failed: ${String(err)}`);
  }
  return done("mcp", stale ? "updated" : "created", `${cli} mcp add cerebrium`);
}

function applyClaude(input: PlanInput, opts: ApplyOptions, todo: SurfaceState[]): Applied[] {
  const dir = join(input.home, ".claude");
  const has = (s: Surface): SurfaceState | undefined => todo.find((t) => t.surface === s);
  const out: Applied[] = [];

  const mcp = has("mcp");
  if (mcp) {
    out.push(
      registerViaCli("claude", ["-s", "user"], input, opts, mcp.status === "stale", "--env"),
    );
  }
  if (has("skill")) {
    out.push(
      ensureSymlink(join(dir, "skills", "cerebrium"), skillPath(input.repoRoot), opts.force),
    );
  }
  if (has("rules")) out.push(writeRules(join(dir, "CLAUDE.md"), input.repoRoot));
  if (has("hook")) out.push(writeClaudeHook(join(dir, "settings.json"), input.repoRoot));
  return out;
}

function applyCodex(input: PlanInput, opts: ApplyOptions, todo: SurfaceState[]): Applied[] {
  const dir = join(input.home, ".codex");
  const has = (s: Surface): SurfaceState | undefined => todo.find((t) => t.surface === s);
  const out: Applied[] = [];

  const mcp = has("mcp");
  if (mcp) out.push(registerViaCli("codex", [], input, opts, mcp.status === "stale", "--env"));
  if (has("skill")) {
    out.push(
      ensureSymlink(join(dir, "skills", "cerebrium"), skillPath(input.repoRoot), opts.force),
    );
  }
  if (has("rules")) out.push(writeRules(join(dir, "AGENTS.md"), input.repoRoot));
  if (has("hook")) out.push(writeCodexHook(join(dir, "hooks.json"), input.repoRoot));
  return out;
}

function applyAntigravity(input: PlanInput, _opts: ApplyOptions, todo: SurfaceState[]): Applied[] {
  const dir = join(input.home, ".gemini", "config");
  const has = (s: Surface): SurfaceState | undefined => todo.find((t) => t.surface === s);
  const out: Applied[] = [];

  if (has("mcp")) {
    const path = join(dir, "mcp_config.json");
    const file = readJson(path);
    const servers = record(file.mcpServers);
    servers.cerebrium = desiredMcp(input.repoRoot, input.env);
    file.mcpServers = servers;
    writeJson(path, file);
    out.push(done("mcp", "updated", path));
  }
  if (has("skill")) {
    const path = join(dir, "skills.json");
    const file = readJson(path);
    const wanted = join(input.repoRoot, "skill");
    const entries: unknown[] = Array.isArray(file.entries) ? file.entries : [];
    file.entries = [...entries.filter((e) => record(e).path !== wanted), { path: wanted }];
    writeJson(path, file);
    out.push(done("skill", "updated", path));
  }
  if (has("hook")) out.push(writeAntigravityHook(join(dir, "hooks.json"), input.repoRoot));
  return out;
}

const APPLIERS: Record<
  HostId,
  (input: PlanInput, opts: ApplyOptions, todo: SurfaceState[]) => Applied[]
> = {
  claude: applyClaude,
  codex: applyCodex,
  antigravity: applyAntigravity,
};

export function applyHost(host: HostId, input: PlanInput, opts: ApplyOptions): Applied[] {
  return APPLIERS[host](input, opts, pending(planHost(host, input)));
}
