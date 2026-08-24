import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ToolName } from "@/presentation/mcp/tools/contracts/tool-name";

// Plans what each agent host still needs to use Cerebrium as memory. Read-only: it
// inspects the host's config and reports a per-surface verdict; nothing here writes.
// The apply side consumes the same plan, so "what is missing" and "what gets written"
// can never disagree.

export const HOSTS = ["claude", "codex", "antigravity"] as const;
export type HostId = (typeof HOSTS)[number];

export const SURFACES = ["mcp", "skill", "rules", "hook", "permissions"] as const;
export type Surface = (typeof SURFACES)[number];

/** `ok` needs nothing; `manual` cannot be automated and is explained in `detail`. */
export type SurfaceStatus = "ok" | "missing" | "stale" | "conflict" | "manual";

export interface SurfaceState {
  surface: Surface;
  status: SurfaceStatus;
  target: string;
  detail: string;
}

export interface HostPlan {
  host: HostId;
  detected: boolean;
  surfaces: SurfaceState[];
  notes: string[];
}

export interface PlanInput {
  home: string;
  repoRoot: string;
  nodePath: string;
  env: Record<string, string>;
  hasCommand: (cmd: string) => boolean;
}

export interface McpEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

const MANAGED_START = "<!-- cerebrium:start";
const MANAGED_END = "<!-- cerebrium:end -->";

type PermissionPolicy = "allow" | "ask";

const ANTIGRAVITY_PERMISSION_POLICY: Record<ToolName, PermissionPolicy> = {
  [ToolName.SESSION_START]: "allow",
  [ToolName.SEARCH]: "allow",
  [ToolName.GET]: "allow",
  [ToolName.WRITE]: "allow",
  [ToolName.UPDATE]: "allow",
  [ToolName.INVALIDATE]: "allow",
  [ToolName.RESTORE]: "allow",
  [ToolName.CHECKPOINT]: "allow",
  [ToolName.LINK]: "allow",
  [ToolName.CODE_INDEX]: "allow",
  [ToolName.JOB_SUBMIT]: "allow",
  [ToolName.JOB_STATUS]: "allow",
  [ToolName.CODE_LOOKUP]: "allow",
  [ToolName.SOURCE_REGISTER]: "allow",
  [ToolName.MIRROR_UPSERT]: "allow",
  [ToolName.MIRROR_STATUS]: "allow",
  [ToolName.CONSOLIDATE_SUGGEST]: "allow",
  [ToolName.CONSOLIDATE_APPLY]: "allow",
  [ToolName.CONSOLIDATE_RETRY]: "allow",
  [ToolName.STATS]: "allow",
};

function grantsFor(policy: Readonly<Record<ToolName, PermissionPolicy>>): string[] {
  return Object.entries(policy)
    .filter(([, value]) => value === "allow")
    .map(([name]) => `mcp(cerebrium/${name})`);
}

export const ANTIGRAVITY_PERMISSION_GRANTS = grantsFor(ANTIGRAVITY_PERMISSION_POLICY);

export const DEFAULT_ENV_KEYS = [
  "MEMORY_DB_PATH",
  "MEMORY_EMBED_PROVIDER",
  "MEMORY_CODE_ROOTS",
  "MEMORY_RERANK",
  "MEMORY_CONSOLIDATE",
] as const;

export function defaultEnv(home: string, repoRoot: string): Record<string, string> {
  return {
    MEMORY_DB_PATH: join(home, ".cerebrium", "memory.db"),
    MEMORY_EMBED_PROVIDER: "local",
    MEMORY_CODE_ROOTS: `cerebrium=${repoRoot}`,
  };
}

export function serverPath(repoRoot: string): string {
  return join(repoRoot, "dist", "server.js");
}

export function skillPath(repoRoot: string): string {
  return join(repoRoot, "skill", "cerebrium");
}

export function hookScript(repoRoot: string): string {
  return join(repoRoot, "install", "hooks", "session-start.mjs");
}

export function hookCommand(repoRoot: string, host: HostId): string {
  return `node ${hookScript(repoRoot)} --host ${host}`;
}

export function desiredMcp(
  repoRoot: string,
  env: Record<string, string>,
  nodePath: string,
): McpEntry {
  return { command: nodePath, args: [serverPath(repoRoot)], env };
}

export function alwaysOnBlock(repoRoot: string): string {
  return readFileSync(join(repoRoot, "install", "always-on.md"), "utf8").trim();
}

export function extractManagedBlock(text: string): string | null {
  const start = text.indexOf(MANAGED_START);
  if (start === -1) return null;
  const end = text.indexOf(MANAGED_END, start);
  if (end === -1) return null;
  return text.slice(start, end + MANAGED_END.length);
}

export function managedBlockConflict(text: string): boolean {
  const starts = text.split(MANAGED_START).length - 1;
  const ends = text.split(MANAGED_END).length - 1;
  if (starts === 0 && ends === 0) return false;
  if (starts !== 1 || ends !== 1) return true;
  const start = text.indexOf(MANAGED_START);
  const end = text.indexOf(MANAGED_END);
  return end < start;
}

export function upsertManagedBlock(text: string, block: string): string {
  if (managedBlockConflict(text)) {
    throw new Error("malformed cerebrium managed block");
  }
  const existing = extractManagedBlock(text);
  if (existing !== null) return text.replace(existing, block);
  const base = text.trimEnd();
  return base === "" ? `${block}\n` : `${base}\n\n${block}\n`;
}

interface JsonFile {
  state: "missing" | "valid" | "conflict";
  value: Record<string, unknown>;
}

function readJson(path: string): JsonFile {
  if (!existsSync(path)) return { state: "missing", value: {} };
  const raw = readFileSync(path, "utf8").trim();
  if (raw === "") return { state: "valid", value: {} };
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? { state: "valid", value: value as Record<string, unknown> }
      : { state: "conflict", value: {} };
  } catch {
    return { state: "conflict", value: {} };
  }
}

function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function state(
  surface: Surface,
  status: SurfaceStatus,
  target: string,
  detail: string,
): SurfaceState {
  return { surface, status, target, detail };
}

/** A JSON `mcpServers` entry is current when it launches this working tree's bundle. */
function mcpState(
  entry: unknown,
  target: string,
  repoRoot: string,
  nodePath: string,
): SurfaceState {
  if (entry === undefined) return state("mcp", "missing", target, "no cerebrium server registered");
  const config = record(entry);
  const exactArgs =
    Array.isArray(config.args) &&
    config.args.length === 1 &&
    config.args[0] === serverPath(repoRoot);
  const exactRuntime = config.command === nodePath;
  return exactArgs && exactRuntime
    ? state("mcp", "ok", target, "registered against this working tree and Node runtime")
    : state("mcp", "stale", target, "registered against a different path or Node runtime");
}

function tomlSection(text: string, name: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === `[${name}]`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => /^\s*\[/.test(line));
  return (next === -1 ? rest : rest.slice(0, next)).join("\n");
}

function tomlString(section: string, key: string): string | null {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, "m");
  const match = pattern.exec(section);
  if (match === null) return null;
  const encoded = match[1];
  if (encoded === undefined) return null;
  try {
    const value: unknown = JSON.parse(encoded);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function tomlStringArray(section: string, key: string): string[] | null {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(\\[[^\\n]*\\])\\s*$`, "m");
  const match = pattern.exec(section);
  if (match === null) return null;
  const encoded = match[1];
  if (encoded === undefined) return null;
  try {
    const value: unknown = JSON.parse(encoded);
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
  } catch {
    return null;
  }
}

function skillLinkState(link: string, repoRoot: string): SurfaceState {
  if (!existsSync(link) && !isSymlink(link)) {
    return state("skill", "missing", link, "skill not installed");
  }
  if (!isSymlink(link)) {
    return state("skill", "conflict", link, "a real directory — a copy that drifts, not a link");
  }
  const dest = readlinkSync(link);
  const resolved = isAbsolute(dest) ? dest : resolve(link, "..", dest);
  return resolved === skillPath(repoRoot)
    ? state("skill", "ok", link, "symlinked to this working tree")
    : state("skill", "stale", link, `symlinked elsewhere (${resolved})`);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function rulesState(path: string, repoRoot: string): SurfaceState {
  const text = readText(path);
  if (text === null) return state("rules", "missing", path, "file does not exist yet");
  if (managedBlockConflict(text)) {
    return state("rules", "conflict", path, "malformed cerebrium managed block");
  }
  const block = extractManagedBlock(text);
  if (block === null) return state("rules", "missing", path, "no managed cerebrium block");
  return block.trim() === alwaysOnBlock(repoRoot)
    ? state("rules", "ok", path, "managed block current")
    : state("rules", "stale", path, "managed block differs from install/always-on.md");
}

function hookState(path: string, present: boolean | null, detail: string): SurfaceState {
  if (present === null) return state("hook", "missing", path, "file does not exist yet");
  return present
    ? state("hook", "ok", path, "session-start hook installed")
    : state("hook", "missing", path, detail);
}

function jsonConflict(surface: Surface, path: string): SurfaceState {
  return state(surface, "conflict", path, "file is not a valid JSON object");
}

export interface PermissionTarget {
  kind: "app" | "cli";
  path: string;
}

export function antigravityPermissionTargets(input: PlanInput): PermissionTarget[] {
  const gemini = join(input.home, ".gemini");
  const app = { kind: "app" as const, path: join(gemini, "config", "config.json") };
  const cli = {
    kind: "cli" as const,
    path: join(gemini, "antigravity-cli", "settings.json"),
  };
  const targets: PermissionTarget[] = [];
  if (existsSync(app.path) || existsSync(join(gemini, "antigravity"))) targets.push(app);
  if (existsSync(cli.path) || input.hasCommand("agy")) targets.push(cli);
  return targets.length > 0 ? targets : [app];
}

export function antigravityPermissionAllowList(
  file: Record<string, unknown>,
  target: PermissionTarget,
): { state: "valid" | "missing" | "conflict"; allow: string[] } {
  const firstKey = target.kind === "app" ? "userSettings" : "permissions";
  const first = file[firstKey];
  if (first === undefined) return { state: "missing", allow: [] };
  if (typeof first !== "object" || first === null || Array.isArray(first)) {
    return { state: "conflict", allow: [] };
  }
  const firstRecord = record(first);
  const container = target.kind === "app" ? firstRecord.globalPermissionGrants : first;
  if (container === undefined) return { state: "missing", allow: [] };
  if (typeof container !== "object" || container === null || Array.isArray(container)) {
    return { state: "conflict", allow: [] };
  }
  const allow = record(container).allow;
  if (allow === undefined) return { state: "missing", allow: [] };
  if (!Array.isArray(allow) || allow.some((entry) => typeof entry !== "string")) {
    return { state: "conflict", allow: [] };
  }
  return { state: "valid", allow: allow as string[] };
}

function permissionsState(input: PlanInput): SurfaceState {
  const targets = antigravityPermissionTargets(input);
  const target = targets.map((entry) => entry.path).join(", ");
  let missing = 0;
  for (const permissionTarget of targets) {
    const file = readJson(permissionTarget.path);
    if (file.state === "conflict") {
      return state("permissions", "conflict", target, `${permissionTarget.path} is invalid`);
    }
    const list = antigravityPermissionAllowList(file.value, permissionTarget);
    if (list.state === "conflict") {
      return state(
        "permissions",
        "conflict",
        target,
        `${permissionTarget.path} has an invalid permission shape`,
      );
    }
    missing += ANTIGRAVITY_PERMISSION_GRANTS.filter((grant) => !list.allow.includes(grant)).length;
  }
  return missing === 0
    ? state("permissions", "ok", target, "all Cerebrium tools explicitly allowed")
    : state("permissions", "missing", target, `${missing} Cerebrium grants missing`);
}

function planClaude(input: PlanInput): HostPlan {
  const { home, repoRoot } = input;
  const dir = join(home, ".claude");
  const claudeJson = join(home, ".claude.json");
  const settings = join(dir, "settings.json");

  const mcp = readJson(claudeJson);
  const hooks = readJson(settings);
  const hookPresent =
    hooks.state === "missing"
      ? null
      : JSON.stringify(record(hooks.value).hooks ?? {}).includes(hookScript(repoRoot));

  return {
    host: "claude",
    detected: existsSync(dir) || input.hasCommand("claude"),
    surfaces: [
      mcp.state === "conflict"
        ? jsonConflict("mcp", claudeJson)
        : mcpState(record(mcp.value.mcpServers).cerebrium, claudeJson, repoRoot, input.nodePath),
      skillLinkState(join(dir, "skills", "cerebrium"), repoRoot),
      rulesState(join(dir, "CLAUDE.md"), repoRoot),
      hooks.state === "conflict"
        ? jsonConflict("hook", settings)
        : hookState(settings, hookPresent, "no SessionStart hook pointing at install/hooks"),
    ],
    notes: [],
  };
}

function planCodex(input: PlanInput): HostPlan {
  const { home, repoRoot } = input;
  const dir = join(home, ".codex");
  const configToml = join(dir, "config.toml");
  const hooksJson = join(dir, "hooks.json");

  const toml = readText(configToml) ?? "";
  const section = tomlSection(toml, "mcp_servers.cerebrium");
  const registered = section !== null;
  const pointsHere =
    section !== null &&
    tomlString(section, "command") === input.nodePath &&
    JSON.stringify(tomlStringArray(section, "args")) === JSON.stringify([serverPath(repoRoot)]);
  const hooks = readJson(hooksJson);
  const hookPresent =
    hooks.state === "missing" ? null : JSON.stringify(hooks.value).includes(hookScript(repoRoot));

  const notes: string[] = [];
  if (!/^\s*hooks\s*=\s*true/m.test(toml)) {
    notes.push(
      "config.toml needs `hooks = true` under [features] — add it by hand; appending a " +
        "second [features] table would break the file",
    );
  }
  notes.push(
    "Codex prompts for hook trust on first run and records the hash itself — approve it there",
  );

  return {
    host: "codex",
    detected: existsSync(dir) || input.hasCommand("codex"),
    surfaces: [
      registered
        ? state(
            "mcp",
            pointsHere ? "ok" : "stale",
            configToml,
            pointsHere
              ? "registered against this working tree and Node runtime"
              : "registered against another path or Node runtime",
          )
        : state("mcp", "missing", configToml, "no [mcp_servers.cerebrium] table"),
      skillLinkState(join(dir, "skills", "cerebrium"), repoRoot),
      rulesState(join(dir, "AGENTS.md"), repoRoot),
      hooks.state === "conflict"
        ? jsonConflict("hook", hooksJson)
        : hookState(hooksJson, hookPresent, "no SessionStart hook pointing at install/hooks"),
    ],
    notes,
  };
}

function planAntigravity(input: PlanInput): HostPlan {
  const { home, repoRoot } = input;
  const dir = join(home, ".gemini", "config");
  const mcpJson = join(dir, "mcp_config.json");
  const skillsJson = join(dir, "skills.json");
  const hooksJson = join(dir, "hooks.json");

  const mcp = readJson(mcpJson);
  const skills = readJson(skillsJson);
  const entries = skills.value.entries;
  const declared =
    Array.isArray(entries) && entries.some((e) => record(e).path === join(repoRoot, "skill"));
  const hooks = readJson(hooksJson);
  const hookPresent =
    hooks.state === "missing" ? null : JSON.stringify(hooks.value).includes(hookScript(repoRoot));

  return {
    host: "antigravity",
    detected:
      existsSync(dir) ||
      existsSync(join(home, ".gemini", "antigravity")) ||
      existsSync(join(home, ".gemini", "antigravity-cli")) ||
      input.hasCommand("agy"),
    surfaces: [
      mcp.state === "conflict"
        ? jsonConflict("mcp", mcpJson)
        : mcpState(record(mcp.value.mcpServers).cerebrium, mcpJson, repoRoot, input.nodePath),
      skills.state === "conflict"
        ? jsonConflict("skill", skillsJson)
        : declared
          ? state("skill", "ok", skillsJson, "skill directory declared by path")
          : state(
              "skill",
              "missing",
              skillsJson,
              "no entry pointing at this working tree's skill/",
            ),
      rulesState(join(home, ".gemini", "GEMINI.md"), repoRoot),
      hooks.state === "conflict"
        ? jsonConflict("hook", hooksJson)
        : hookState(hooksJson, hookPresent, "no PreInvocation hook pointing at install/hooks"),
      permissionsState(input),
    ],
    notes: [],
  };
}

const PLANNERS: Record<HostId, (input: PlanInput) => HostPlan> = {
  claude: planClaude,
  codex: planCodex,
  antigravity: planAntigravity,
};

export function planHost(host: HostId, input: PlanInput): HostPlan {
  return PLANNERS[host](input);
}

export function planAll(input: PlanInput, hosts: readonly HostId[] = HOSTS): HostPlan[] {
  return hosts.map((host) => planHost(host, input));
}

export function pending(plan: HostPlan): SurfaceState[] {
  return plan.surfaces.filter((s) => s.status !== "ok" && s.status !== "manual");
}

/**
 * The environment of whichever host is already registered. One store per machine: a
 * second `MEMORY_DB_PATH` is a second memory, which is the failure this prevents.
 */
export function discoverEnv(input: PlanInput): Record<string, string> | null {
  const { home } = input;
  const fromJson = (path: string): Record<string, string> | null => {
    const file = readJson(path);
    if (file.state !== "valid") return null;
    const entry = record(file.value.mcpServers).cerebrium;
    if (entry === undefined) return null;
    const env = record(record(entry).env);
    return Object.fromEntries(
      Object.entries(env).filter(([, v]) => typeof v === "string"),
    ) as Record<string, string>;
  };

  const claude = fromJson(join(home, ".claude.json"));
  if (claude !== null) return claude;
  const antigravity = fromJson(join(home, ".gemini", "config", "mcp_config.json"));
  if (antigravity !== null) return antigravity;
  return codexEnv(readText(join(home, ".codex", "config.toml")) ?? "");
}

/** Reads only the `env` inline table of `[mcp_servers.cerebrium]` — not a TOML parser. */
export function codexEnv(toml: string): Record<string, string> | null {
  const table = toml.split("[mcp_servers.cerebrium]")[1];
  if (table === undefined) return null;
  const section = table.split(/^\[/m)[0] ?? "";
  const inline = /env\s*=\s*\{([^}]*)\}/.exec(section);
  const body = inline?.[1] ?? "";
  const env: Record<string, string> = {};
  for (const match of body.matchAll(/"?([A-Z_][A-Z0-9_]*)"?\s*=\s*"([^"]*)"/g)) {
    env[match[1]!] = match[2]!;
  }
  return env;
}
