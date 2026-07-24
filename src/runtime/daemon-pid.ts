import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultDbPath } from "@/db/database";

// The daemon's singleton marker lives next to the DB file so it tracks the DB it
// drains (a different MEMORY_DB_PATH gets its own daemon). Spawn-dedup only — the
// worker_lease row is the correctness guard for who actually writes embeddings.
export function daemonPidPath(dbPath = defaultDbPath()): string {
  const dir = dbPath === ":memory:" ? process.cwd() : dirname(dbPath);
  return join(dir, "daemon.pid");
}

export function readDaemonPid(dbPath = defaultDbPath()): number | null {
  try {
    const pid = Number.parseInt(readFileSync(daemonPidPath(dbPath), "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Liveness via signal 0: no signal sent, but the existence/permission check tells
// us whether the pid is a live process. A stale pidfile (dead pid) reads as dead.
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isDaemonAlive(dbPath = defaultDbPath()): boolean {
  const pid = readDaemonPid(dbPath);
  return pid != null && pid !== process.pid && isProcessAlive(pid);
}

export function writeDaemonPid(dbPath = defaultDbPath()): void {
  writeFileSync(daemonPidPath(dbPath), String(process.pid), "utf8");
}

export function clearDaemonPid(dbPath = defaultDbPath()): void {
  try {
    rmSync(daemonPidPath(dbPath));
  } catch {
    /* already gone */
  }
}
