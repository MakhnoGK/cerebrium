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

type Call = (method: string, params: Record<string, unknown>) => Promise<unknown>;

// Closing a job that never got as far as spawning. Still reported rather than abandoned, so
// the lease is released now instead of at expiry.
function fail(call: Call, id: string, owner: string, error: string): Promise<unknown> {
  return call("job_finish", {
    id,
    owner,
    report: {
      exit: "failed",
      result: null,
      cost_usd: null,
      turns: null,
      duration_ms: 0,
      model: null,
      permission_denials: 0,
      error,
      usage: null,
    },
  });
}

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

  // Bare node runs the server, and it cannot execute TypeScript. From source
  // `resolveServerPath` finds `src/server.ts`, which exists — so existence is not the check
  // that matters, the extension is, exactly as `isInstallableDaemonPath` already says for
  // the daemon. Spawning anyway is worse than failing: the agent starts, finds no Cerebrium
  // tools, flails for several turns, and reports success having done nothing. Observed.
  if (!deps.serverPath.endsWith(".js")) {
    await fail(
      call,
      job.id,
      deps.owner,
      `server path ${deps.serverPath} is not a .js bundle; run the runner from a build`,
    );

    return "ran";
  }

  const task = taskFor(job.kind);

  if (task === undefined) {
    // Claimed a kind this build cannot run, which only happens if the registry and the
    // claim list drift. Report it rather than hold the lease until it expires.
    await fail(call, job.id, deps.owner, `no task registered for ${job.kind}`);

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

  // Exiting cleanly is not the same as having done the job. A run whose MCP server failed
  // to start still exits 0, having answered from nothing — so the task judges its own
  // result, and a run that cannot show its work is a failure however calmly it ended.
  const rejected = outcome.exit === "completed" ? task.verify(outcome.result) : null;

  const reported =
    rejected === null
      ? outcome
      : { ...outcome, exit: "failed" as const, error: `unusable result: ${rejected}` };

  deps.log(
    `${job.kind} ${reported.exit} in ${String(Math.round(outcome.duration_ms / 1000))}s` +
      (outcome.cost_usd === null ? "" : ` ($${outcome.cost_usd.toFixed(4)})`) +
      (rejected === null ? "" : ` — ${rejected}`),
  );

  await call("job_finish", { id: job.id, owner: deps.owner, report: reported });

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

const USAGE = `cerebrium-runner [--once <kind>]

  (no arguments)   run the claim loop until stopped; needs runner.enabled
  --once <kind>    enqueue one job of that kind, run it in the foreground, exit

  Registered tasks: ${TASK_KINDS.join(", ")}

--once ignores runner.enabled on purpose: it is how an operator verifies the runner or
triggers a task deliberately, and it runs exactly one job and stops. The loop is what
runner.enabled arms, because that is the part that runs unattended.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const container = buildContainer({ role: "runner", kernel: "remote" });
  const runner = container.resolve(RunnerConfig);

  const onceAt = argv.indexOf("--once");
  const named = onceAt < 0 ? undefined : argv[onceAt + 1];

  if (onceAt >= 0 && (named === undefined || named.startsWith("-"))) {
    process.stderr.write(`--once needs a kind. ${USAGE}`);
    process.exit(2);
  }

  const once: string | null = named ?? null;

  if (once === null && !runner.enabled) {
    process.stderr.write("runner disabled by config; exiting (use --once to run one job)\n");
    process.exit(0);
  }

  const owner = newId();
  let stopping = false;

  const shutdown = () => {
    stopping = true;
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  const deps = {
    socketPath: container.resolve(DaemonConfig).socketPath,
    owner,
    serverPath: resolveServerPath(),
    dbPath: container.resolve(DatabaseConfig).path,
    client: runner.client,
    cwd: runner.cwd,
    cli: runner.cli,
    maxBudgetUsd: runner.maxBudgetUsd,
    log: (line: string) => process.stderr.write(`${line}\n`),
  };

  if (once !== null) {
    const job = (await rpcCall({ socketPath: deps.socketPath, timeoutMs: 30_000 }, "job_enqueue", {
      kind: once,
    })) as { id: string };

    deps.log(`enqueued ${once} as ${job.id}`);

    const did = await runOnce(deps);

    deps.log(did === "ran" ? "done" : "nothing was claimable");

    return;
  }

  process.stderr.write(`runner ${owner} up, tasks: ${TASK_KINDS.join(", ")}\n`);

  await runLoop({ ...deps, idleMs: runner.idleMs, stopped: () => stopping });
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`cerebrium runner failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
