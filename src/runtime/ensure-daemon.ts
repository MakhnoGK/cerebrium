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

// The daemon's location relative to this module depends on the build layout: bundled
// (tsup) the bins are flat siblings in dist/ ("./daemon.js"); running from source
// (tsx) it is one level up ("../daemon.ts"). Resolve by probing rather than assuming.
export function resolveDaemonPath(): string {
  for (const rel of ["./daemon.js", "../daemon.js", "./daemon.ts", "../daemon.ts"]) {
    const p = fileURLToPath(new URL(rel, import.meta.url));

    if (existsSync(p)) {
      return p;
    }
  }

  return fileURLToPath(new URL("./daemon.js", import.meta.url));
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
