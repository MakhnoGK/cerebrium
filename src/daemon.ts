#!/usr/bin/env node
import "reflect-metadata";
import { ModelWarmupService, ProcessRegistryService } from "@/application/services";
import { ConsolidationWorker, EmbeddingWorker } from "@/application/workers";
import { EmbeddingQueueRepo } from "@/db/repositories";
import { clearDaemonPid, isDaemonAlive, writeDaemonPid } from "@/runtime/daemon-pid";
import { isMainModule } from "@/runtime/is-main";
import { buildContainer } from "@/container";
import { ConsolidationConfig, DaemonConfig, DatabaseConfig } from "@/infrastructure/config";

// Standalone embedding drain. Outlives any Claude Code session: the MCP server
// spawns it detached (see ensureDaemon in server.ts) and it keeps draining the
// shared queue until the backlog is empty and it has been idle long enough to be
// worth releasing the ~120MB model. Then it exits and the next session respawns
// it. It is the canonical writer for embeddings; the worker_lease still guards
// against any overlap with a fallback in-process worker.

export interface DaemonOptions {
  activeIntervalMs?: number; // poll cadence while there is a backlog
  idleIntervalMs?: number; // poll cadence once the queue is empty
  idleExitMs?: number; // exit after this long with an empty queue
}

// The model sustains hundreds of chunks/sec; a dedicated daemon should feed it in
// large batches and loop with only an event-loop yield between ticks (not a real
// sleep) while there is a backlog. The gentle 3s in-process fallback worker is a
// different, politer citizen — this is not that.
const ACTIVE_MS = 0;
const IDLE_MS = 5000;
const IDLE_EXIT_MS = 5 * 60_000;

export interface IdleState {
  idleSinceMs: number | null;
}

// Pure idle-exit decision, extracted so it is testable without real timers.
// `nowMs` is injected; `idleSinceMs` carries across calls. Once the queue has
// been continuously empty for `idleExitMs`, signal exit.
export function nextIdleState(
  prev: IdleState,
  backlog: number,
  nowMs: number,
  idleExitMs: number,
): {
  state: IdleState;
  shouldExit: boolean;
} {
  if (backlog > 0) {
    return { state: { idleSinceMs: null }, shouldExit: false };
  }

  const since = prev.idleSinceMs ?? nowMs;

  return { state: { idleSinceMs: since }, shouldExit: nowMs - since >= idleExitMs };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runDaemon(
  queue: EmbeddingQueueRepo,
  worker: EmbeddingWorker,
  opts: DaemonOptions & {
    stopped?: () => boolean;
    sleepMs?: (ms: number) => Promise<void>;
    nowMs?: () => number;
    consolidation?: ConsolidationWorker;
    consolidateIntervalMs?: number;
  } = {},
): Promise<void> {
  const active = opts.activeIntervalMs ?? ACTIVE_MS;
  const idle = opts.idleIntervalMs ?? IDLE_MS;
  const idleExit = opts.idleExitMs ?? IDLE_EXIT_MS;
  const stopped = opts.stopped ?? (() => false);
  const nap = opts.sleepMs ?? sleep;
  const now = opts.nowMs ?? Date.now;
  const consolidation = opts.consolidation;
  const consolidateInterval = opts.consolidateIntervalMs ?? IDLE_EXIT_MS;

  worker.reconcile();

  let idleState: IdleState = { idleSinceMs: null };
  let lastConsolidateMs = -Infinity;

  while (!stopped()) {
    await worker.tick();
    const { backlog } = queue.embeddingStats();
    // Consolidate only when caught up on embeddings (kNN over half-embedded content is
    // noise) and no more than once per interval. Runs promptly on reaching idle, before
    // the idle-exit countdown can retire the process.
    if (consolidation && backlog === 0 && now() - lastConsolidateMs >= consolidateInterval) {
      lastConsolidateMs = now();

      const swept = await consolidation.tick();

      const total =
        swept.distilled + swept.merged + swept.pruned + swept.links_added + swept.annotated;
      const failures = swept.generation_failures;
      if (total > 0 || failures > 0) {
        process.stderr.write(
          `consolidation: ${total} actions${failures > 0 ? `, ${String(failures)} failure(s) (last: ${swept.last_error ?? "unknown"})` : ""}\n`,
        );
      }
    }

    const { state, shouldExit } = nextIdleState(idleState, backlog, now(), idleExit);
    idleState = state;

    if (shouldExit) {
      return;
    }

    await nap(backlog > 0 ? active : idle);
  }
}

async function main(): Promise<void> {
  const container = buildContainer({ role: "daemon" });
  const dbPath = container.resolve(DatabaseConfig).path;

  // Registrations are lazy, so this bails out before the DB is ever opened.
  if (isDaemonAlive(dbPath)) {
    return; // another daemon owns this DB
  }

  const daemonConfig = container.resolve(DaemonConfig);
  const queue = container.resolve(EmbeddingQueueRepo);
  const worker = container.resolve(EmbeddingWorker);
  const consolidation = container.resolve(ConsolidationWorker);

  const registry = container.resolve(ProcessRegistryService);
  const warmup = container.resolve(ModelWarmupService);

  writeDaemonPid(dbPath);
  const registered = registry.publish("daemon");

  let stopping = false;

  const shutdown = async () => {
    stopping = true;

    await Promise.all([worker.stop(), consolidation.stop()]);
    registry.retire(registered);
    clearDaemonPid(dbPath);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  // Before the loop, not inside its first tick: this is the process that exists to hold
  // the model, so it should finish loading while nothing is waiting on it. The MCP
  // server's fallback worker deliberately does NOT do this — there the load would stall
  // the client's own startup, and a background timer is already off the request path.
  const warmed = await warmup.warm();

  registry.recordModel(registered, warmed);

  process.stderr.write(
    warmed.state === "ready"
      ? `model ready in ${String(warmed.ms)}ms\n`
      : `model failed to load after ${String(warmed.ms)}ms: ${warmed.error ?? "unknown"}\n`,
  );

  try {
    await runDaemon(queue, worker, {
      stopped: () => stopping,
      consolidation,
      activeIntervalMs: daemonConfig.activeIntervalMs,
      idleIntervalMs: daemonConfig.idleIntervalMs,
      idleExitMs: daemonConfig.idleExitMs,
      consolidateIntervalMs: container.resolve(ConsolidationConfig).intervalMs,
    });
  } finally {
    // `stopping` is flipped by the SIGTERM/SIGINT handler above; eslint's flow
    // analysis can't see that closure mutation and reads it as always-false.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!stopping) {
      await Promise.all([worker.stop(), consolidation.stop()]);
      registry.retire(registered);
      clearDaemonPid(dbPath);
    }
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    // No clearDaemonPid() here: the pidfile is written inside main(), which clears it in
    // its own finally with the resolved path. Clearing it from here would target the
    // DEFAULT path and could delete a healthy daemon's pidfile.
    process.stderr.write(`cerebrium daemon failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
