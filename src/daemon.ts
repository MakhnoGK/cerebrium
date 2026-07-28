#!/usr/bin/env node
import "reflect-metadata";
import Database from "better-sqlite3";
import { container } from "tsyringe";
import { CLOCK_TOKEN } from "@/domain/ports/clock";
import { consolidateIntervalMs } from "@/consolidation/config";
import { createConsolidator, type ConsolidationProvider } from "@/consolidation/index";
import { ConsolidationWorker } from "@/consolidation/worker";
import { defaultDbPath, openDatabase } from "@/db/database";
import { EmbeddingQueueRepo } from "@/db/repositories";
import { DB_TOKEN } from "@/db/repositories/base";
import {
  createProvider,
  EMBEDDING_PROVIDER_TOKEN,
  type EmbeddingProvider,
} from "@/embeddings/index";
import { EmbeddingWorker, WORKER_OPTIONS_TOKEN } from "@/embeddings/worker";
import { clearDaemonPid, isDaemonAlive, writeDaemonPid } from "@/runtime/daemon-pid";
import { isMainModule } from "@/runtime/is-main";
import { SystemClock } from "@/runtime/system-clock";
import { CONSOLIDATOR_TOKEN } from "@/tools/services/consolidation.service";

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
const ACTIVE_MS = Number(process.env.MEMORY_DAEMON_ACTIVE_MS) || 0;
const IDLE_MS = 5000;
const IDLE_EXIT_MS = Number(process.env.MEMORY_DAEMON_IDLE_MS) || 5 * 60_000;

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
  if (backlog > 0) return { state: { idleSinceMs: null }, shouldExit: false };
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
  const consolidateInterval = opts.consolidateIntervalMs ?? consolidateIntervalMs();

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
      await consolidation.tick();
    }
    const { state, shouldExit } = nextIdleState(idleState, backlog, now(), idleExit);
    idleState = state;
    if (shouldExit) return;
    await nap(backlog > 0 ? active : idle);
  }
}

async function main(): Promise<void> {
  const dbPath = defaultDbPath();
  if (isDaemonAlive(dbPath)) return; // another daemon owns this DB

  container.register<Database.Database>(DB_TOKEN, { useValue: openDatabase(dbPath) });
  container.registerSingleton(CLOCK_TOKEN, SystemClock);
  // The daemon feeds the model in large batches (vs. the gentle in-process fallback).
  container.register(WORKER_OPTIONS_TOKEN, {
    useValue: { batchSize: Number(process.env.MEMORY_EMBED_BATCH) || 64 },
  });
  container.register<EmbeddingProvider>(EMBEDDING_PROVIDER_TOKEN, { useValue: createProvider() });
  container.register<ConsolidationProvider>(CONSOLIDATOR_TOKEN, { useValue: createConsolidator() });

  const queue = container.resolve(EmbeddingQueueRepo);
  const worker = container.resolve(EmbeddingWorker);
  const consolidation = container.resolve(ConsolidationWorker);

  writeDaemonPid(dbPath);
  let stopping = false;
  const shutdown = async () => {
    stopping = true;
    await Promise.all([worker.stop(), consolidation.stop()]);
    clearDaemonPid(dbPath);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  try {
    await runDaemon(queue, worker, { stopped: () => stopping, consolidation });
  } finally {
    // `stopping` is flipped by the SIGTERM/SIGINT handler above; eslint's flow
    // analysis can't see that closure mutation and reads it as always-false.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!stopping) {
      await Promise.all([worker.stop(), consolidation.stop()]);
      clearDaemonPid(dbPath);
    }
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`cerebrium daemon failed: ${(err as Error).message}\n`);
    clearDaemonPid();
    process.exit(1);
  });
}
