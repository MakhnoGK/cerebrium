#!/usr/bin/env node
import "reflect-metadata";
import { runAgent, type AgentRunOutcome } from "@/runtime/agent-run";
import { resolveServerPath } from "@/runtime/ensure-daemon";
import { isMainModule } from "@/runtime/is-main";
import { cerebriumHome } from "@/runtime/paths";
import { rpcCall } from "@/runtime/rpc-client";
import { newId } from "@/core/ids";
import { buildContainer } from "@/container";
import { DaemonConfig, DatabaseConfig, RunnerConfig } from "@/infrastructure/config";
import { TASK_KINDS, taskFor, type TaskContext } from "@/runner/tasks";

// The runner host. A second supervised process, sibling to the daemon and holding no
// database: it reaches the store only over the socket, and only through the three job
// methods. Everything it knows how to run is declared in `@/runner/tasks`.
//
// It exists as its own process because the kernel spawns nothing. Putting `claude -p`
// behind the daemon would put orchestration in the one process that owns the database,
// which is the line the whole design is drawn around.

interface JobRow {
  id: string;
  kind: string;
  payload_json: string;
}

const RENEW_MS = 300_000;

function payloadOf(job: JobRow): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(job.payload_json);

    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function runOnce(deps: {
  socketPath: string;
  owner: string;
  serverPath: string;
  dbPath: string;
  client: string;
  cwd: string;
  cli: string;
  // Deployment ceiling. A task's own cap is clamped to this, so adding a task cannot raise
  // what one run is allowed to spend past what the install permits.
  maxBudgetUsd: number;
  log: (line: string) => void;
}): Promise<"ran" | "idle"> {
  const call = (method: string, params: Record<string, unknown>) =>
    rpcCall({ socketPath: deps.socketPath, timeoutMs: 30_000 }, method, params);

  const job = (await call("job_claim", {
    kinds: [...TASK_KINDS],
    owner: deps.owner,
  })) as JobRow | null;

  if (job === null) return "idle";

  const task = taskFor(job.kind);

  if (task === undefined) {
    // Claimed a kind this build cannot run, which only happens if the registry and the
    // claim list drift. Report it rather than hold the lease until it expires.
    await call("job_finish", {
      id: job.id,
      owner: deps.owner,
      report: {
        exit: "failed",
        result: null,
        cost_usd: null,
        turns: null,
        duration_ms: 0,
        model: null,
        permission_denials: 0,
        error: `no task registered for ${job.kind}`,
        usage: null,
      },
    });

    return "ran";
  }

  // A run can outlast the lease, so renew while it is in flight — the same reason the
  // daemon's own job worker renews from a timer.
  const renew = setInterval(() => {
    void call("job_renew", { id: job.id, owner: deps.owner }).catch(() => undefined);
  }, RENEW_MS);

  renew.unref();

  let outcome: AgentRunOutcome;

  try {
    const ctx: TaskContext = { call: (name, args) => call(name, args) };
    const prompt = await task.prompt(ctx, payloadOf(job));

    const budget = Math.min(task.maxBudgetUsd, deps.maxBudgetUsd);

    deps.log(`running ${job.kind} (${task.model}, cap $${String(budget)})`);

    outcome = await runAgent(
      {
        prompt,
        model: task.model,
        allowedTools: task.allowedTools,
        maxBudgetUsd: budget,
        timeoutMs: task.timeoutMs,
        cwd: deps.cwd,
        client: deps.client,
        server: {
          command: process.execPath,
          args: [deps.serverPath],
          env: { MEMORY_DB_PATH: deps.dbPath, CEREBRIUM_HOME: cerebriumHome() },
        },
      },
      { cli: deps.cli },
    );
  } catch (err) {
    outcome = {
      exit: "failed",
      result: null,
      cost_usd: null,
      usage: null,
      turns: null,
      duration_ms: 0,
      model: null,
      permission_denials: 0,
      error: (err as Error).message,
    };
  } finally {
    clearInterval(renew);
  }

  deps.log(
    `${job.kind} ${outcome.exit} in ${String(Math.round(outcome.duration_ms / 1000))}s` +
      (outcome.cost_usd === null ? "" : ` ($${outcome.cost_usd.toFixed(4)})`),
  );

  await call("job_finish", { id: job.id, owner: deps.owner, report: outcome });

  return "ran";
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runLoop(
  deps: Parameters<typeof runOnce>[0] & {
    idleMs: number;
    stopped: () => boolean;
    sleepMs?: (ms: number) => Promise<void>;
  },
): Promise<void> {
  const nap = deps.sleepMs ?? sleep;

  // Strictly one at a time. Concurrency here would multiply spend against a budget shared
  // with the owner's own interactive sessions, which is the scarce resource — not money.
  while (!deps.stopped()) {
    const did = await runOnce(deps).catch((err: unknown) => {
      deps.log(`runner error: ${(err as Error).message}`);

      return "idle" as const;
    });

    if (did === "idle") await nap(deps.idleMs);
  }
}

async function main(): Promise<void> {
  const container = buildContainer({ role: "runner", kernel: "remote" });
  const runner = container.resolve(RunnerConfig);

  if (!runner.enabled) {
    process.stderr.write("runner disabled by config; exiting\n");
    process.exit(0);
  }

  const owner = newId();
  let stopping = false;

  const shutdown = () => {
    stopping = true;
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  process.stderr.write(`runner ${owner} up, tasks: ${TASK_KINDS.join(", ")}\n`);

  await runLoop({
    socketPath: container.resolve(DaemonConfig).socketPath,
    owner,
    serverPath: resolveServerPath(),
    dbPath: container.resolve(DatabaseConfig).path,
    client: runner.client,
    cwd: runner.cwd,
    cli: runner.cli,
    maxBudgetUsd: runner.maxBudgetUsd,
    idleMs: runner.idleMs,
    stopped: () => stopping,
    log: (line) => process.stderr.write(`${line}\n`),
  });
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`cerebrium runner failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
