import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCtx } from "./helpers";
import { nextIdleState, runDaemon } from "@/daemon";
import {
  daemonPidPath,
  readDaemonPid,
  writeDaemonPid,
  clearDaemonPid,
  isDaemonAlive,
  isProcessAlive,
} from "@/runtime/daemon-pid";
import { ensureDaemon } from "@/runtime/ensure-daemon";
import * as session_start from "@/tools/session_start";
import * as write from "@/tools/write";

const DB = join(tmpdir(), `mk-daemon-${process.pid}.db`);
afterEach(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });
  rmSync(daemonPidPath(DB), { force: true });
});

describe("nextIdleState", () => {
  it("resets the idle timer whenever there is a backlog", () => {
    const r = nextIdleState({ idleSinceMs: 100 }, 3, 500, 1000);
    expect(r.state.idleSinceMs).toBeNull();
    expect(r.shouldExit).toBe(false);
  });

  it("starts the idle timer on first empty tick and exits after the threshold", () => {
    const first = nextIdleState({ idleSinceMs: null }, 0, 1000, 1000);
    expect(first.state.idleSinceMs).toBe(1000);
    expect(first.shouldExit).toBe(false);

    const later = nextIdleState(first.state, 0, 2000, 1000);
    expect(later.shouldExit).toBe(true);
  });
});

describe("daemon pidfile", () => {
  it("round-trips the pid and treats a dead pid as not alive", () => {
    expect(readDaemonPid(DB)).toBeNull();
    writeDaemonPid(DB);
    expect(readDaemonPid(DB)).toBe(process.pid);
    // isDaemonAlive excludes our own pid (we are the server, not the daemon).
    expect(isDaemonAlive(DB)).toBe(false);
    clearDaemonPid(DB);
    expect(readDaemonPid(DB)).toBeNull();
  });

  it("isProcessAlive: true for self, false for a dead pid", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2_147_483_646)).toBe(false);
  });
});

describe("runDaemon loop", () => {
  it("drains the backlog to empty then exits on idle", async () => {
    const { ctx, repo, worker } = makeCtx();
    const s = (await session_start.handler(ctx, {})).session_id;
    await write.handler(ctx, {
      session_id: s,
      memory_kind: "semantic",
      type: "fact",
      title: "drain me",
      content: "a fact with enough words to make a chunk worth embedding",
    });
    expect(repo.embeddingStats().backlog).toBe(1);

    let clock = 0;
    await runDaemon(repo, worker, {
      idleExitMs: 50,
      nowMs: () => (clock += 100), // each check jumps past the idle threshold
      sleepMs: () => Promise.resolve(),
    });

    expect(repo.embeddingStats().backlog).toBe(0);
  });

  it("honors an external stop signal", async () => {
    const { repo, worker } = makeCtx();
    let stop = false;
    const p = runDaemon(repo, worker, {
      stopped: () => stop,
      idleExitMs: 1_000_000,
      nowMs: () => 0,
      sleepMs: async () => {
        stop = true; // stop after the first idle sleep
      },
    });
    await expect(p).resolves.toBeUndefined();
  });
});

describe("ensureDaemon", () => {
  const saved = process.env.MEMORY_EMBED_PROVIDER;
  afterEach(() => {
    if (saved === undefined) delete process.env.MEMORY_EMBED_PROVIDER;
    else process.env.MEMORY_EMBED_PROVIDER = saved;
  });

  it("skips spawning under the local-null provider", () => {
    process.env.MEMORY_EMBED_PROVIDER = "local-null";
    expect(ensureDaemon(DB)).toBe("skipped");
  });
});
