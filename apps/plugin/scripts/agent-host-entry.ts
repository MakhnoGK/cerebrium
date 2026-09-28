import { lstatSync } from "node:fs";
import { join } from "node:path";
import { parseKernelTarget } from "@cerebrium/contracts/rpc";
import {
  done,
  registerViaCli,
  type Applied,
  type ApplyOptions,
  type CliEntry,
} from "@plugin/scripts/agent-apply";
import {
  pluginRoot,
  readJson,
  readText,
  record,
  tomlSection,
  tomlString,
  tomlStringArray,
  type SurfaceState,
} from "@plugin/scripts/agent-hosts";

// The trial entry: a second MCP server, `cerebrium-host`, that runs the plugin bundle
// against a Cerebrium host. It sits beside the `cerebrium` entry and never touches it, or
// any other surface; its env names the token file, never the token.

export const HOST_ENTRY = "cerebrium-host";
export const HOST_ENTRY_HOSTS = ["claude", "codex"] as const;
export type HostEntryHost = (typeof HOST_ENTRY_HOSTS)[number];

export interface HostEntryInput {
  home: string;
  repoRoot: string;
  nodePath: string;
  kernelUrl: string;
  tokenFile: string;
  hasCommand: (cmd: string) => boolean;
}

export function pluginServerPath(repoRoot: string): string {
  return join(pluginRoot(repoRoot), "dist", "server.js");
}

export function hostEntryEnv(input: HostEntryInput): Record<string, string> {
  return { MEMORY_KERNEL_URL: input.kernelUrl, MEMORY_KERNEL_TOKEN_FILE: input.tokenFile };
}

// Every reason the entry could not work, checked without reading the token.
export function hostEntryProblems(input: HostEntryInput): string[] {
  const problems: string[] = [];

  try {
    if (parseKernelTarget(input.kernelUrl).kind !== "tcp") {
      problems.push(`--kernel ${input.kernelUrl} is not a tcp://host:port URL`);
    }
  } catch (err) {
    problems.push(`--kernel ${input.kernelUrl}: ${(err as Error).message}`);
  }

  let mode: number;

  try {
    const stat = lstatSync(input.tokenFile);

    if (!stat.isFile()) {
      problems.push(`--token-file ${input.tokenFile} is not a regular file`);

      return problems;
    }
    mode = stat.mode & 0o777;
  } catch {
    problems.push(`--token-file ${input.tokenFile} does not exist`);

    return problems;
  }

  if ((mode & 0o077) !== 0) {
    problems.push(
      `--token-file ${input.tokenFile} is readable by others (mode ${mode.toString(8)}); ` +
        `run chmod 600 on it`,
    );
  }

  return problems;
}

function entry(input: HostEntryInput): CliEntry {
  return {
    name: HOST_ENTRY,
    env: hostEntryEnv(input),
    command: input.nodePath,
    args: [pluginServerPath(input.repoRoot)],
  };
}

function sameEnv(actual: Record<string, unknown>, wanted: Record<string, string>): boolean {
  const keys = Object.keys(actual);

  return (
    keys.length === Object.keys(wanted).length && keys.every((key) => actual[key] === wanted[key])
  );
}

function surface(status: SurfaceState["status"], target: string, detail: string): SurfaceState {
  return { surface: "mcp", status, target, detail };
}

function claudeState(input: HostEntryInput): SurfaceState {
  const path = join(input.home, ".claude.json");
  const file = readJson(path);

  if (file.state === "conflict") return surface("conflict", path, "not a JSON object");

  const found = record(file.value.mcpServers)[HOST_ENTRY];

  if (found === undefined) return surface("missing", path, `no ${HOST_ENTRY} server registered`);

  const wanted = entry(input);
  const config = record(found);
  const current =
    config.command === wanted.command &&
    JSON.stringify(config.args) === JSON.stringify(wanted.args) &&
    sameEnv(record(config.env), wanted.env);

  return current
    ? surface("ok", path, `${HOST_ENTRY} runs the plugin bundle against ${input.kernelUrl}`)
    : surface("stale", path, `${HOST_ENTRY} is registered with another bundle, runtime or env`);
}

/** Codex writes the env as a `[…env]` subtable; an inline `env = {…}` is read as well. */
export function codexServerEnv(toml: string, name: string): Record<string, string> | null {
  const section = tomlSection(toml, `mcp_servers.${name}`);

  if (section === null) return null;

  const table = tomlSection(toml, `mcp_servers.${name}.env`);
  const body = table ?? /env\s*=\s*\{([^}]*)\}/.exec(section)?.[1] ?? "";
  const env: Record<string, string> = {};

  for (const match of body.matchAll(/"?([A-Z_][A-Z0-9_]*)"?\s*=\s*"([^"]*)"/g)) {
    env[match[1]!] = match[2]!;
  }

  return env;
}

function codexState(input: HostEntryInput): SurfaceState {
  const path = join(input.home, ".codex", "config.toml");
  const toml = readText(path) ?? "";
  const section = tomlSection(toml, `mcp_servers.${HOST_ENTRY}`);

  if (section === null) return surface("missing", path, `no [mcp_servers.${HOST_ENTRY}] table`);

  const wanted = entry(input);
  const current =
    tomlString(section, "command") === wanted.command &&
    JSON.stringify(tomlStringArray(section, "args")) === JSON.stringify(wanted.args) &&
    sameEnv(codexServerEnv(toml, HOST_ENTRY) ?? {}, wanted.env);

  return current
    ? surface("ok", path, `${HOST_ENTRY} runs the plugin bundle against ${input.kernelUrl}`)
    : surface("stale", path, `${HOST_ENTRY} is registered with another bundle, runtime or env`);
}

export function planHostEntry(host: HostEntryHost, input: HostEntryInput): SurfaceState {
  return host === "claude" ? claudeState(input) : codexState(input);
}

export function applyHostEntry(
  host: HostEntryHost,
  input: HostEntryInput,
  opts: ApplyOptions,
): Applied {
  const planned = planHostEntry(host, input);

  if (planned.status === "ok") return done("mcp", "unchanged", `${HOST_ENTRY} is current`);
  if (planned.status === "conflict") {
    return done("mcp", "failed", `${planned.target}: ${planned.detail}`);
  }

  return registerViaCli(
    host,
    host === "claude" ? ["-s", "user"] : [],
    entry(input),
    input.hasCommand,
    opts,
    planned.status === "stale",
    "--env",
  );
}
