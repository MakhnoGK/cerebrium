import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

// Plans what each agent host still needs to use Cerebrium as memory. Read-only: it
// inspects the host's config and reports a per-surface verdict; nothing here writes.
// The apply side consumes the same plan, so "what is missing" and "what gets written"
// can never disagree.

export const HOSTS = ["claude", "codex", "antigravity"] as const;
export type HostId = (typeof HOSTS)[number];

export const SURFACES = ["mcp", "skill", "rules", "hook"] as const;
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

export function desiredMcp(repoRoot: string, env: Record<string, string>): McpEntry {
  return { command: "node", args: [serverPath(repoRoot)], env };
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

export function upsertManagedBlock(text: string, block: string): string {
  const existing = extractManagedBlock(text);
  if (existing !== null) return text.replace(existing, block);
  const base = text.trimEnd();
  return base === "" ? `${block}\n` : `${base}\n\n${block}\n`;
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  if (raw === "") return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
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
function mcpState(entry: unknown, target: string, repoRoot: string): SurfaceState {
  if (entry === undefined) return state("mcp", "missing", target, "no cerebrium server registered");
  const args = record(entry).args;
  const points = Array.isArray(args) && args.some((a) => a === serverPath(repoRoot));
  return points
    ? state("mcp", "ok", target, "registered against this working tree")
    : state("mcp", "stale", target, "registered against a different path");
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

function planClaude(input: PlanInput): HostPlan {
  const { home, repoRoot } = input;
  const dir = join(home, ".claude");
  const claudeJson = join(home, ".claude.json");
  const settings = join(dir, "settings.json");

  const mcp = readJson(claudeJson);
  const hooks = readJson(settings);
  const hookPresent =
    hooks === null
      ? null
      : JSON.stringify(record(hooks).hooks ?? {}).includes(hookScript(repoRoot));

  return {
    host: "claude",
    detected: existsSync(dir) || input.hasCommand("claude"),
    surfaces: [
      mcpState(record(mcp?.mcpServers).cerebrium, claudeJson, repoRoot),
      skillLinkState(join(dir, "skills", "cerebrium"), repoRoot),
      rulesState(join(dir, "CLAUDE.md"), repoRoot),
      hookState(settings, hookPresent, "no SessionStart hook pointing at install/hooks"),
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
  const registered = toml.includes("[mcp_servers.cerebrium]");
  const pointsHere = registered && toml.includes(serverPath(repoRoot));
  const hooks = readJson(hooksJson);
  const hookPresent = hooks === null ? null : JSON.stringify(hooks).includes(hookScript(repoRoot));

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
            pointsHere ? "registered against this working tree" : "registered against another path",
          )
        : state("mcp", "missing", configToml, "no [mcp_servers.cerebrium] table"),
      skillLinkState(join(dir, "skills", "cerebrium"), repoRoot),
      rulesState(join(dir, "AGENTS.md"), repoRoot),
      hookState(hooksJson, hookPresent, "no SessionStart hook pointing at install/hooks"),
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

  const skills = readJson(skillsJson);
  const entries = record(skills).entries;
  const declared =
    Array.isArray(entries) && entries.some((e) => record(e).path === join(repoRoot, "skill"));
  const hooks = readJson(hooksJson);
  const hookPresent = hooks === null ? null : JSON.stringify(hooks).includes(hookScript(repoRoot));

  return {
    host: "antigravity",
    detected: existsSync(dir),
    surfaces: [
      mcpState(record(readJson(mcpJson)?.mcpServers).cerebrium, mcpJson, repoRoot),
      declared
        ? state("skill", "ok", skillsJson, "skill directory declared by path")
        : state("skill", "missing", skillsJson, "no entry pointing at this working tree's skill/"),
      state(
        "rules",
        "manual",
        "AGENTS.md per project",
        "rules are discovered by walking up from the working directory; there is no " +
          "machine-wide rules file, so the block goes into each project's AGENTS.md",
      ),
      hookState(hooksJson, hookPresent, "no PreInvocation hook pointing at install/hooks"),
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
    const entry = record(readJson(path)?.mcpServers).cerebrium;
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
