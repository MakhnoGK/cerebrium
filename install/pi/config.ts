import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// How the pi extension learns to launch Cerebrium. pi has no MCP layer of its own, so the
// entry every other host keeps in its config file lives here instead: one JSON object in
// pi's agent directory, written by `agent:setup --host pi --apply`, holding the same
// command/args/env an `mcpServers` entry would. Nothing in here imports pi, so it stays
// testable from this repo's vitest.

export interface LaunchConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface BridgeOptions {
  /** Fill an omitted `session_id` from the session this extension opened. */
  autoSessionId: boolean;
  /** Append the always-on retrieval rules to pi's system prompt. */
  rules: boolean;
  /** Offer this working tree's `skill/` directory to pi's skill discovery. */
  skill: boolean;
  /** Call `session_start` at session start and announce the working set. */
  greet: boolean;
}

export interface ResolvedConfig {
  launch: LaunchConfig;
  options: BridgeOptions;
  repoRoot: string;
  configPath: string;
  /** Where `launch` came from, for `/cerebrium status`. */
  source: "config file" | "repository defaults";
}

export interface ResolveInput {
  repoRoot: string;
  home?: string;
  env?: Record<string, string | undefined>;
  execPath?: string;
}

export const DEFAULT_OPTIONS: BridgeOptions = {
  autoSessionId: true,
  rules: true,
  skill: true,
  greet: true,
};

const INHERITED_PREFIXES = ["MEMORY_", "CEREBRIUM_"];

/** The directory this file sits in is inside the working tree, so the tree locates itself. */
export function repoRootFromHere(here: string = fileURLToPath(import.meta.url)): string {
  return resolve(dirname(here), "..", "..");
}

export function serverPath(repoRoot: string): string {
  return join(repoRoot, "dist", "server.js");
}

export function skillRoot(repoRoot: string): string {
  return join(repoRoot, "skill");
}

/**
 * Which project to focus the working set on. Guessing from the directory name would invent
 * a project the store has never heard of and hand back an empty working set, so the only
 * accepted answer is a code root the owner already declared in `MEMORY_CODE_ROOTS`.
 */
export function projectForCwd(roots: string | undefined, cwd: string): string | undefined {
  if (roots === undefined) return undefined;
  const within = roots
    .split(",")
    .map((entry) => {
      const eq = entry.indexOf("=");
      if (eq < 0) return null;
      const name = entry.slice(0, eq).trim();
      const root = entry.slice(eq + 1).trim();
      return name === "" || root === "" ? null : { name, root: resolve(root) };
    })
    .filter((entry): entry is { name: string; root: string } => entry !== null)
    .filter((entry) => cwd === entry.root || cwd.startsWith(`${entry.root}/`))
    .sort((a, b) => b.root.length - a.root.length);
  return within[0]?.name;
}

/** Mirrors pi's own `getAgentDir()` without importing pi, so tests can call it. */
export function agentDir(
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.PI_CODING_AGENT_DIR;
  return override !== undefined && override !== "" ? override : join(home, ".pi", "agent");
}

export function configPath(home?: string, env?: Record<string, string | undefined>): string {
  return join(agentDir(home, env), "cerebrium.json");
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringMap(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record(value)).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items: unknown[] = value;
  return items.every((item) => typeof item === "string") ? items : null;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** `MEMORY_*` / `CEREBRIUM_*` already in pi's environment, so a shell export still works. */
export function inheritedEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => {
      const [key, value] = entry;
      return typeof value === "string" && INHERITED_PREFIXES.some((p) => key.startsWith(p));
    }),
  );
}

export function readConfigFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (raw === "") return null;
    return record(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function parseOptions(value: unknown): BridgeOptions {
  const options = record(value);
  return {
    autoSessionId: bool(options.autoSessionId, DEFAULT_OPTIONS.autoSessionId),
    rules: bool(options.rules, DEFAULT_OPTIONS.rules),
    skill: bool(options.skill, DEFAULT_OPTIONS.skill),
    greet: bool(options.greet, DEFAULT_OPTIONS.greet),
  };
}

/**
 * File first, then the working tree it was written from. An env var the user exported still
 * reaches the server: the file's `env` is layered over the inherited one, never instead of it.
 */
export function resolveConfig(input: ResolveInput): ResolvedConfig {
  const env = input.env ?? process.env;
  const path = configPath(input.home, env);
  const file = readConfigFile(path);
  const inherited = inheritedEnv(env);

  const command = typeof file?.command === "string" ? file.command : null;
  const args = stringList(file?.args);

  return {
    launch: {
      command: command ?? input.execPath ?? process.execPath,
      args: args ?? [serverPath(input.repoRoot)],
      env: { ...inherited, ...stringMap(file?.env) },
    },
    options: parseOptions(file?.options),
    repoRoot: input.repoRoot,
    configPath: path,
    source: file !== null && command !== null ? "config file" : "repository defaults",
  };
}
