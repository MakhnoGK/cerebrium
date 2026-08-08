import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  alwaysOnBlock,
  ANTIGRAVITY_PERMISSION_GRANTS,
  antigravityPermissionAllowList,
  antigravityPermissionTargets,
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
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (raw === "") return {};
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.cerebrium-${process.pid}-${randomUUID()}.tmp`;
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  try {
    writeFileSync(temporary, content, { mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function writeJson(path: string, value: unknown): void {
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
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
  try {
    const existed = existsSync(path);
    const before = existed ? readFileSync(path, "utf8") : "";
    const after = upsertManagedBlock(before, alwaysOnBlock(repoRoot));
    if (after === before) return done("rules", "unchanged", path);
    writeAtomic(path, after);
    return done("rules", existed ? "updated" : "created", path);
  } catch (err) {
    return done("rules", "failed", `${path}: ${String(err)}`);
  }
}

/** Drops any group that already points at our hook script, so a re-run cannot stack them. */
function withoutOurs(groups: unknown, repoRoot: string): unknown[] {
  return Array.isArray(groups)
    ? groups.filter((g) => !JSON.stringify(g).includes(hookScript(repoRoot)))
    : [];
}

function writeClaudeHook(path: string, repoRoot: string): Applied {
  return updateJson("hook", path, (settings) => {
    const hooks = record(settings.hooks);
    hooks.SessionStart = [
      ...withoutOurs(hooks.SessionStart, repoRoot),
      {
        matcher: "",
        hooks: [{ type: "command", command: hookCommand(repoRoot, "claude"), timeout: 5 }],
      },
    ];
    settings.hooks = hooks;
  });
}

function writeCodexHook(path: string, repoRoot: string): Applied {
  return updateJson("hook", path, (file) => {
    const hooks = record(file.hooks);
    hooks.SessionStart = [
      ...withoutOurs(hooks.SessionStart, repoRoot),
      { hooks: [{ type: "command", command: hookCommand(repoRoot, "codex"), timeout: 5 }] },
    ];
    file.hooks = hooks;
  });
}

function writeAntigravityHook(path: string, repoRoot: string): Applied {
  return updateJson("hook", path, (file) => {
    file.cerebrium = {
      PreInvocation: [
        { type: "command", command: hookCommand(repoRoot, "antigravity"), timeout: 10 },
      ],
    };
  });
}

function updateJson(
  surface: Surface,
  path: string,
  mutate: (file: Record<string, unknown>) => void,
): Applied {
  try {
    const existed = existsSync(path);
    const file = readJson(path);
    mutate(file);
    writeJson(path, file);
    return done(surface, existed ? "updated" : "created", path);
  } catch (err) {
    return done(surface, "failed", `${path}: ${String(err)}`);
  }
}

function writeAntigravityPermissions(input: PlanInput): Applied {
  const targets = antigravityPermissionTargets(input);
  try {
    const files = targets.map((target) => {
      const file = readJson(target.path);
      const current = antigravityPermissionAllowList(file, target);
      if (current.state === "conflict") throw new Error(`${target.path} has an invalid shape`);
      const allow = [...new Set([...current.allow, ...ANTIGRAVITY_PERMISSION_GRANTS])];
      if (target.kind === "app") {
        const userSettings = record(file.userSettings);
        const grants = record(userSettings.globalPermissionGrants);
        grants.allow = allow;
        userSettings.globalPermissionGrants = grants;
        file.userSettings = userSettings;
      } else {
        const permissions = record(file.permissions);
        permissions.allow = allow;
        file.permissions = permissions;
      }
      return { path: target.path, file };
    });
    for (const entry of files) writeJson(entry.path, entry.file);
    return done("permissions", "updated", targets.map((target) => target.path).join(", "));
  } catch (err) {
    return done("permissions", "failed", String(err));
  }
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
    out.push(
      updateJson("mcp", path, (file) => {
        const servers = record(file.mcpServers);
        servers.cerebrium = desiredMcp(input.repoRoot, input.env);
        file.mcpServers = servers;
      }),
    );
  }
  if (has("skill")) {
    const path = join(dir, "skills.json");
    out.push(
      updateJson("skill", path, (file) => {
        const wanted = join(input.repoRoot, "skill");
        const entries: unknown[] = Array.isArray(file.entries) ? file.entries : [];
        file.entries = [...entries.filter((e) => record(e).path !== wanted), { path: wanted }];
      }),
    );
  }
  if (has("rules")) out.push(writeRules(join(input.home, ".gemini", "GEMINI.md"), input.repoRoot));
  if (has("hook")) out.push(writeAntigravityHook(join(dir, "hooks.json"), input.repoRoot));
  if (has("permissions")) out.push(writeAntigravityPermissions(input));
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
