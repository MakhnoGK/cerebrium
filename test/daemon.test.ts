import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { container } from "tsyringe";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearDaemonPid,
  daemonPidPath,
  isDaemonAlive,
  isProcessAlive,
  readDaemonPid,
  writeDaemonPid,
} from "@/runtime/daemon-pid";
import { ensureDaemon } from "@/runtime/ensure-daemon";
import { _MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/tools/session-start";
import { WriteTool } from "@/tools/write";
import { nextIdleState, runDaemon } from "@/daemon";
import { setup } from "@test/helpers";

const DB = join(tmpdir(), `mk-daemon-${process.pid}.db`);
afterEach(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });
  rmSync(daemonPidPath(DB), { force: true });
});

describe("nextIdleState", () => {
  it("should reset the idle timer whenever there is a backlog", () => {
    // Given / When
    const r = nextIdleState({ idleSinceMs: 100 }, 3, 500, 1000);

    // Then
    expect(r.state.idleSinceMs).toBeNull();
    expect(r.shouldExit).toBe(false);
  });

  it("should start the idle timer on the first empty tick and exit after the threshold", () => {
    // Given / When
    const first = nextIdleState({ idleSinceMs: null }, 0, 1000, 1000);

    // Then
    expect(first.state.idleSinceMs).toBe(1000);
    expect(first.shouldExit).toBe(false);

    // When / Then
    const later = nextIdleState(first.state, 0, 2000, 1000);
    expect(later.shouldExit).toBe(true);
  });
});

describe("Daemon pidfile", () => {
  it("should round-trip the pid and treat a dead pid as not alive", () => {
    // Given / When / Then
    expect(readDaemonPid(DB)).toBeNull();
    writeDaemonPid(DB);
    expect(readDaemonPid(DB)).toBe(process.pid);
    // isDaemonAlive excludes our own pid (we are the server, not the daemon).
    expect(isDaemonAlive(DB)).toBe(false);
    clearDaemonPid(DB);
    expect(readDaemonPid(DB)).toBeNull();
  });

  it("should treat self as alive and a dead pid as not alive", () => {
    // Given / When / Then
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2_147_483_646)).toBe(false);
  });
});

describe("runDaemon loop", () => {
  it("should drain the backlog to empty then exit on idle", async () => {
    // Given
    const env = setup();
    const s = (await container.resolve(SessionStartTool).invoke({})).session_id;
    await container.resolve(WriteTool).invoke({
      session_id: s,
      memory_kind: _MemoryKind.SEMANTIC,
      type: "fact",
      title: "drain me",
      content: "a fact with enough words to make a chunk worth embedding",
    });
    expect(env.queue.embeddingStats().backlog).toBe(1);

    // When
    let clock = 0;
    await runDaemon(env.queue, env.worker, {
      idleExitMs: 50,
      nowMs: () => (clock += 100), // each check jumps past the idle threshold
      sleepMs: () => Promise.resolve(),
    });

    // Then
    expect(env.queue.embeddingStats().backlog).toBe(0);
  });

  it("should honor an external stop signal", async () => {
    // Given
    const env = setup();
    let stop = false;

    // When
    const p = runDaemon(env.queue, env.worker, {
      stopped: () => stop,
      idleExitMs: 1_000_000,
      nowMs: () => 0,
      sleepMs: async () => {
        stop = true; // stop after the first idle sleep
      },
    });

    // Then
    await expect(p).resolves.toBeUndefined();
  });
});

describe("ensureDaemon", () => {
  const saved = process.env.MEMORY_EMBED_PROVIDER;
  afterEach(() => {
    if (saved === undefined) delete process.env.MEMORY_EMBED_PROVIDER;
    else process.env.MEMORY_EMBED_PROVIDER = saved;
  });

  it("should skip spawning under the local-null provider", () => {
    // Given
    process.env.MEMORY_EMBED_PROVIDER = "local-null";

    // When / Then
    expect(ensureDaemon(DB)).toBe("skipped");
  });
});
