import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDaemonAlive } from "@/runtime/daemon-pid";
import { cerebriumHome } from "@/runtime/paths";

export type EnsureResult = "spawned" | "already-running" | "skipped";

export interface EnsureDaemonOptions {
  // The DB this process resolved. The pidfile lives beside it, and the child is pinned to
  // it, so parent and child can never disagree about which database is being drained.
  dbPath: string;
  embedProvider: string;
}

// A bin's location relative to this module depends on the build layout: bundled (tsup) the
// bins are flat siblings in dist/ ("./daemon.js"); running from source (tsx) each one sits in
// its app's src/. Resolve by probing rather than assuming.
const SOURCE_BIN_DIRS = ["../../../../apps/host/src", "../../../../apps/plugin/src"];

function resolveBinPath(name: string): string {
  const candidates = [`./${name}.js`, ...SOURCE_BIN_DIRS.map((dir) => `${dir}/${name}.ts`)];

  for (const rel of candidates) {
    const p = fileURLToPath(new URL(rel, import.meta.url));

    if (existsSync(p)) {
      return p;
    }
  }

  return fileURLToPath(new URL(`./${name}.js`, import.meta.url));
}

export function resolveDaemonPath(): string {
  return resolveBinPath("daemon");
}

export function resolveRunnerPath(): string {
  return resolveBinPath("runner");
}

// Called on MCP server startup. If no daemon is draining this DB, spawn one
// detached so it survives this session ending. The `local-null` provider (tests,
// throwaway dev) is skipped — the caller runs a cheap in-process worker instead.
export function ensureDaemon({ dbPath, embedProvider }: EnsureDaemonOptions): EnsureResult {
  if (embedProvider === "local-null") {
    return "skipped";
  }

  if (isDaemonAlive(dbPath)) {
    return "already-running";
  }

  const daemonPath = resolveDaemonPath();
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: "ignore",
    // Both halves of the resolution are pinned: the install root the child reads
    // config.json from, and the database it drains.
    env: { ...process.env, CEREBRIUM_HOME: cerebriumHome(), MEMORY_DB_PATH: dbPath },
  });

  child.unref();

  return "spawned";
}

// The MCP server entry point, resolved the same way the daemon's is: bundled they are flat
// siblings in dist/, from source each is in its app's src/. The runner hands this path to the
// agent it spawns, so the agent talks to the same build the runner does.
export function resolveServerPath(): string {
  return resolveBinPath("server");
}
