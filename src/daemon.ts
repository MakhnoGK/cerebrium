#!/usr/bin/env node
import "reflect-metadata";
import type { ConsolidationTickResult } from "@/domain/ports/consolidation-reporter";
import { EMBEDDING_PROVIDER_TOKEN, EmbeddingRole } from "@/domain/ports/embedding-provider";
import { CallPipeline } from "@/application/call-pipeline";
import {
  ActivityMonitor,
  ModelWarmupService,
  PrincipalQuotaService,
  ProcessRegistryService,
  SubscriptionService,
  type WarmupOutcome,
} from "@/application/services";
import { NotificationTopic } from "@/application/use-cases";
import { ConsolidationWorker, EmbeddingWorker } from "@/application/workers";
import { ConsolidationRepo, EmbeddingQueueRepo } from "@/db/repositories";
import { resolveEmbedWorker, WorkerEmbeddingProvider } from "@/embeddings/worker-provider";
import { clearDaemonPid, isDaemonAlive, writeDaemonPid } from "@/runtime/daemon-pid";
import { isMainModule } from "@/runtime/is-main";
import { launchdPid } from "@/runtime/launch-agent";
import { nodeWorkerFactory, resolveReadWorker } from "@/runtime/node-pool-worker";
import { ReadPool } from "@/runtime/read-pool";
import { createDaemonMethods, RpcServer, surfaceMethods } from "@/presentation/rpc";
import { buildContainer } from "@/container";
import {
  ConsolidationConfig,
  DaemonConfig,
  DatabaseConfig,
  EmbeddingConfig,
} from "@/infrastructure/config";

// Standalone embedding drain. Outlives any Claude Code session: the MCP server
// spawns it detached (see ensureDaemon in server.ts) and it keeps draining the
// shared queue until the backlog is empty and it has been idle long enough to be
// worth releasing the ~120MB model. Then it exits and the next session respawns
// it. It is the canonical writer for embeddings; the worker_lease still guards
// against any overlap with a fallback in-process worker.
//
// Under `daemon.resident` it never exits on its own and a supervisor (launchd) owns
// the lifetime instead. Without a supervisor, resident mode strands a process that
// nothing will ever restart or reap — `cerebrium-service install` sets both together.

export interface DaemonOptions {
  activeIntervalMs?: number; // poll cadence while there is a backlog
  idleIntervalMs?: number; // poll cadence once the queue is empty
  idleExitMs?: number; // exit after this long with an empty queue
  resident?: boolean; // never idle-exit; a supervisor owns the lifetime
  // True while a client is waiting. Consolidation shares this process with the reads, so
  // it neither starts nor continues while one is.
  busy?: () => boolean;
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

// Under a supervisor, "another daemon owns this DB" must not be an exit. Exiting 0 with
// launchd's KeepAlive set means being respawned forever — a ~10s loop that never converges
// while a session-spawned daemon holds the pidfile. Waiting keeps the supervised process
// up and lets it take over the moment the other one goes away.
// A daemon that finds the database already owned is in one of two situations, and only one
// of them should wait for the owner to leave:
//
//   - launchd's own daemon, restarted while a stray still holds the database. Exiting here
//     is what produced the throttled respawn loop, because `KeepAlive` restarts on any exit.
//   - a stray — session-spawned or started by the desktop app. Waiting here is what left
//     idle second writers accumulating, one per spawn, each with the file open read-write.
//
// The daemon cannot tell these apart from its own configuration: both are the same binary,
// and `resident` only says it was asked to stay. Only launchd knows which pid it manages.
export function stepsAside(opts: {
  resident: boolean;
  managedPid: number | null;
  pid: number;
}): boolean {
  return !opts.resident || opts.managedPid !== opts.pid;
}

export async function waitForOwnership(opts: {
  owned: () => boolean;
  sleepMs: (ms: number) => Promise<void>;
  intervalMs: number;
  stopped?: () => boolean;
  maxWaits?: number;
}): Promise<"acquired" | "stopped"> {
  const stopped = opts.stopped ?? (() => false);

  for (let waits = 0; opts.maxWaits === undefined || waits < opts.maxWaits; waits++) {
    if (stopped()) return "stopped";
    if (!opts.owned()) return "acquired";

    await opts.sleepMs(opts.intervalMs);
  }

  return "stopped";
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
    // Called with each sweep's result, for whoever wants to tell somebody about it. The
    // loop does not know about the socket, and should not.
    onSwept?: (result: ConsolidationTickResult) => void;
  } = {},
): Promise<void> {
  const active = opts.activeIntervalMs ?? ACTIVE_MS;
  const idle = opts.idleIntervalMs ?? IDLE_MS;
  const idleExit = opts.idleExitMs ?? IDLE_EXIT_MS;
  const resident = opts.resident ?? false;
  const busy = opts.busy ?? (() => false);
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
    // An empty embedding backlog is not the same idle as "nobody is waiting": the first is
    // about this process's own queue, the second about the clients it serves.
    if (
      consolidation &&
      backlog === 0 &&
      !busy() &&
      now() - lastConsolidateMs >= consolidateInterval
    ) {
      lastConsolidateMs = now();

      const swept = await consolidation.tick({ shouldYield: busy });

      opts.onSwept?.(swept);

      const total =
        swept.distilled +
        swept.merged +
        swept.pruned +
        swept.links_added +
        swept.wikilinks_linked +
        swept.annotated;
      const failures = swept.generation_failures;
      if (total > 0 || failures > 0 || swept.yielded) {
        process.stderr.write(
          `consolidation: ${total} actions` +
            (swept.yielded === true ? " (yielded to a client)" : "") +
            (failures > 0
              ? `, ${String(failures)} failure(s) (last: ${swept.last_error ?? "unknown"})`
              : "") +
            "\n",
        );
      }
    }

    const { state, shouldExit } = nextIdleState(idleState, backlog, now(), idleExit);
    idleState = state;

    if (shouldExit && !resident) {
      return;
    }

    await nap(backlog > 0 ? active : idle);
  }
}

async function main(): Promise<void> {
  const container = buildContainer({ role: "daemon" });
  const dbPath = container.resolve(DatabaseConfig).path;

  const daemonConfig = container.resolve(DaemonConfig);

  // The model goes in its own thread when there is a bundle to spawn. Loading it blocks for
  // over a second, and this is the thread that answers the socket — with the model here,
  // every call during startup timed out, `status` included.
  const embedEntry = resolveEmbedWorker();

  if (embedEntry !== null) {
    const embedding = container.resolve(EmbeddingConfig);

    container.register(EMBEDDING_PROVIDER_TOKEN, {
      useValue: new WorkerEmbeddingProvider(embedEntry, {
        provider: embedding.provider,
        model: embedding.model,
        cacheDir: embedding.cacheDir,
        url: embedding.url,
        timeoutMs: embedding.timeoutMs,
        batchSize: embedding.batchSize,
      }),
    });
  }

  // Registrations are lazy, so this decides before the DB is ever opened.
  if (isDaemonAlive(dbPath)) {
    if (
      stepsAside({ resident: daemonConfig.resident, managedPid: launchdPid(), pid: process.pid })
    ) {
      // Nothing has been claimed yet — no pidfile, no registry row, no lease — so leaving
      // is clean. `return` was not: it ended `main`, not the process, and a stray went on
      // holding a writable handle on the database for as long as the machine was up.
      process.exit(0);
    }

    process.stderr.write("another daemon owns this database; waiting for it to exit\n");

    await waitForOwnership({
      owned: () => isDaemonAlive(dbPath),
      sleepMs: sleep,
      intervalMs: daemonConfig.idleIntervalMs,
    });

    process.stderr.write("took over the database\n");
  }
  const queue = container.resolve(EmbeddingQueueRepo);
  const worker = container.resolve(EmbeddingWorker);
  const consolidation = container.resolve(ConsolidationWorker);

  // A sweep killed outright leaves its row open, and only the process that starts next can
  // say so. `interrupted` is the truth; a row still open would read as a sweep in progress
  // for as long as the store lives.
  const abandoned = container
    .resolve(ConsolidationRepo)
    .closeAbandonedRuns("the daemon exited before the sweep finished");

  if (abandoned > 0) {
    process.stderr.write(`closed ${String(abandoned)} abandoned sweep(s)\n`);
  }

  const registry = container.resolve(ProcessRegistryService);
  const warmup = container.resolve(ModelWarmupService);

  writeDaemonPid(dbPath);
  const registered = registry.publish("daemon");

  let stopping = false;
  let model: WarmupOutcome | null = null;

  // Reads run off this thread when there is a built worker to spawn. From source there is
  // none, and reads stay in-process exactly as before.
  const workerEntry = resolveReadWorker();
  const pool =
    workerEntry === null
      ? null
      : new ReadPool({
          size: daemonConfig.readWorkers,
          spawn: nodeWorkerFactory(workerEntry, dbPath),
        });

  if (pool === null) {
    process.stderr.write("no read worker bundle; serving reads in-process\n");
  }

  // Listening starts before the model is loaded, and the handler reads whatever state
  // warming has reached. That ordering is the whole point of `status`: a daemon that is
  // still loading, or whose load failed, must still be able to say so.
  // Reads that arrive over the socket go to the pool; the pipeline attaches the session
  // check and the audit row either way.
  const pipeline = container.resolve(CallPipeline);
  const activity = container.resolve(ActivityMonitor);

  // A read worker holds no model, so a semantic search needs its vector computed here — on
  // this thread, where the model worker answers in a few milliseconds — before the query
  // goes to the pool.
  const embedForRead = async (name: string, args: unknown): Promise<unknown> => {
    if (name !== "search_memory" || typeof args !== "object" || args === null) return args;

    const query = args as { query?: unknown; mode?: unknown; query_vector?: unknown };

    if (query.mode === "text" || query.query_vector !== undefined) return args;

    if (typeof query.query !== "string" || !query.query.length) return args;

    try {
      const [vector] = await container
        .resolve<{
          embed: (t: string[], r: EmbeddingRole) => Promise<number[][]>;
        }>(EMBEDDING_PROVIDER_TOKEN)
        .embed([query.query], EmbeddingRole.QUERY);

      return vector === undefined ? args : { ...args, query_vector: vector };
    } catch {
      // No vector means the text half still answers, which beats failing the search.
      return args;
    }
  };

  pipeline.useReadDispatcher(
    pool === null
      ? undefined
      : async (name, args) => pool.invoke(name, await embedForRead(name, args)),
  );

  const rpc = new RpcServer(
    {
      ...surfaceMethods((name, args, writer) => pipeline.invoke(container, name, args, writer)),
      ...createDaemonMethods(
        container,
        {
          pid: process.pid,
          model: () => model,
          principals: () => container.resolve(PrincipalQuotaService).usage(Date.now()),
          ...(pool === null ? {} : { queueDepth: () => pool.depth }),
        },
        pool === null ? undefined : (name, args) => pool.invoke(name, args),
      ),
    },
    {
      isOwnedByLiveDaemon: () => isDaemonAlive(dbPath),
      onError: (message) => process.stderr.write(`rpc: ${message}\n`),
    },
  );

  // The first producer on the push channel. Fire-and-forget by design: a subscriber that
  // was not connected reads the run from `consolidation_runs` instead, so nothing here has
  // to be durable.
  const subscriptions = container.resolve(SubscriptionService);
  const publishSweep = (swept: ConsolidationTickResult): void => {
    if (swept.stage === "failed" || subscriptions.subscribers === 0) return;

    rpc.notify(
      "consolidation.swept",
      {
        links_added: swept.links_added,
        wikilinks_linked: swept.wikilinks_linked,
        wikilinks_dangling: swept.wikilinks_dangling,
        distill_suggested: swept.distill_suggested,
        merge_suggested: swept.merge_suggested,
        prune_suggested: swept.prune_suggested,
        yielded: swept.yielded === true,
      },
      (client) => subscriptions.wants(client, NotificationTopic.CONSOLIDATION),
    );
  };

  const shutdown = async () => {
    stopping = true;

    await Promise.all([worker.stop(), consolidation.stop(), rpc.close(), pool?.close()]);
    registry.retire(registered);
    clearDaemonPid(dbPath);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  try {
    await rpc.listen(daemonConfig.socketPath);
  } catch (err) {
    // A daemon that cannot be asked anything still drains the queue, which is the job it
    // had before the socket existed.
    process.stderr.write(`rpc unavailable: ${(err as Error).message}\n`);
  }

  // Before the loop, not inside its first tick: this is the process that exists to hold
  // the model, so it should finish loading while nothing is waiting on it. The MCP
  // server's fallback worker deliberately does NOT do this — there the load would stall
  // the client's own startup, and a background timer is already off the request path.
  const warmed = await warmup.warm();

  model = warmed;
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
      resident: daemonConfig.resident,
      busy: () => !activity.isQuiet(daemonConfig.quietMs) || (pool?.depth ?? 0) > 0,
      consolidateIntervalMs: container.resolve(ConsolidationConfig).intervalMs,
      onSwept: publishSweep,
    });
  } finally {
    // `stopping` is flipped by the SIGTERM/SIGINT handler above; eslint's flow
    // analysis can't see that closure mutation and reads it as always-false.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!stopping) {
      await Promise.all([worker.stop(), consolidation.stop(), rpc.close(), pool?.close()]);
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
