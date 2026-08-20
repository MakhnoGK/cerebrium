import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { container } from "tsyringe";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonService } from "@/application/services";
import {
  clearDaemonPid,
  daemonPidPath,
  isDaemonAlive,
  isProcessAlive,
  readDaemonPid,
  writeDaemonPid,
} from "@/runtime/daemon-pid";
import { ensureDaemon } from "@/runtime/ensure-daemon";
import { MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { nextIdleState, runDaemon } from "@/daemon";
import { DatabaseConfig, StaticConfigSource } from "@/infrastructure/config";
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

describe("DaemonService", () => {
  it("should look for the pidfile beside the configured database, not the default one", () => {
    // Given
    const service = new DaemonService(
      new DatabaseConfig(new StaticConfigSource({ MEMORY_DB_PATH: DB })),
    );

    // When
    writeDaemonPid(DB);

    // Then
    expect(service.getDaemonPidPath(DB)).toBe(daemonPidPath(DB));
    expect(service.readDaemonPid()).toBe(process.pid);
  });
});

describe("runDaemon loop", () => {
  it("should drain the backlog to empty then exit on idle", async () => {
    // Given
    const env = setup();
    const s = (await container.resolve(SessionStartTool).invoke({})).session_id;
    await container.resolve(WriteTool).invoke({
      session_id: s,
      parent_node_id: null,
      memory_kind: MemoryKind.SEMANTIC,
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

  it("should keep running past the idle threshold when resident", async () => {
    // Given
    const env = setup();
    let stop = false;
    let ticks = 0;
    let clock = 0;

    // When — the same advancing clock that makes the non-resident loop exit on its
    // second idle check; only `stopped` ends this one.
    const p = runDaemon(env.queue, env.worker, {
      resident: true,
      stopped: () => stop,
      idleExitMs: 50,
      nowMs: () => (clock += 100),
      sleepMs: () => {
        if (++ticks >= 3) stop = true;

        return Promise.resolve();
      },
    });

    // Then
    await expect(p).resolves.toBeUndefined();
    expect(ticks).toBe(3);
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
  it("should skip spawning under the local-null provider", () => {
    // Given / When / Then — the decision comes from the resolved config, not process.env.
    expect(ensureDaemon({ dbPath: DB, embedProvider: "local-null" })).toBe("skipped");
  });
});
