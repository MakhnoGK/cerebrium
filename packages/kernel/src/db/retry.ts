// One SQLite file, but multiple stdio server processes (one per Claude Code
// session) open it. WAL serializes writers; `busy_timeout` makes better-sqlite3
// sleep-retry while acquiring a lock. This wrapper is the residual safety net:
// even with a generous timeout, a contended write can still surface SQLITE_BUSY
// (notably SQLITE_BUSY_SNAPSHOT on a deferred read->write upgrade). Re-run the
// whole transaction a few times with short backoff before giving up.

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

// Synchronous sleep without a CPU spin — better-sqlite3 is synchronous, so we
// cannot await between attempts.
function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

const BUSY_CODES = new Set(["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_LOCKED"]);

export function isBusy(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code != null && BUSY_CODES.has(code);
}

export function withBusyRetry<T>(fn: () => T, attempts = 6, baseMs = 25): T {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (err) {
      if (!isBusy(err) || i >= attempts - 1) throw err;
      sleepSync(Math.min(baseMs * 2 ** i, 500));
    }
  }
}
