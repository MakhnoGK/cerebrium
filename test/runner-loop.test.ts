import { describe, expect, it, vi } from "vitest";
import * as agentRun from "@/runtime/agent-run";
import * as rpc from "@/runtime/rpc-client";
import { JobKind } from "@/core/vocab";
import { runLoop, runOnce, scheduleDue } from "@/runner";
import { RECURRING_TASKS } from "@/runner/tasks";

const DEPS = {
  socketPath: "/tmp/x.sock",
  owner: "runner-1",
  serverPath: "/x/server.js",
  dbPath: "/x/memory.db",
  client: "cerebrium-runner",
  cwd: "/tmp",
  cli: "claude",
  maxBudgetUsd: 1,
  log: () => undefined,
};

const OUTCOME: agentRun.AgentRunOutcome = {
  exit: "completed",
  result: "ok",
  cost_usd: 0.05,
  usage: null,
  turns: 3,
  duration_ms: 6000,
  model: "haiku",
  permission_denials: 0,
  error: null,
};

// Records every RPC the runner makes, and answers job_claim from a scripted queue.
function harness(queue: unknown[]) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];

  vi.spyOn(rpc, "rpcCall").mockImplementation((_o, method, params = {}) => {
    calls.push({ method, params });

    return Promise.resolve(method === "job_claim" ? (queue.shift() ?? null) : true);
  });

  return calls;
}

describe("runner loop", () => {
  it("should report idle without spawning anything when the queue is empty", async () => {
    // Given
    harness([]);
    const spawned = vi.spyOn(agentRun, "runAgent");

    // When
    const did = await runOnce(DEPS);

    // Then
    expect(did).toBe("idle");
    expect(spawned).not.toHaveBeenCalled();
  });

  it("should spawn the task and report the outcome back when a job is claimed", async () => {
    // Given
    const calls = harness([{ id: "job-1", kind: JobKind.AGENT_SELFTEST, payload_json: "{}" }]);
    vi.spyOn(agentRun, "runAgent").mockResolvedValue(OUTCOME);

    // When
    const did = await runOnce(DEPS);

    // Then
    expect(did).toBe("ran");

    const finish = calls.find((c) => c.method === "job_finish");
    expect(finish?.params.id).toBe("job-1");
    expect((finish?.params.report as { cost_usd: number }).cost_usd).toBe(0.05);
  });

  it("should clamp a task's budget to the deployment ceiling", async () => {
    // Given — the selftest asks for 0.25; the install allows 0.10.
    harness([{ id: "job-1", kind: JobKind.AGENT_SELFTEST, payload_json: "{}" }]);
    const spawned = vi.spyOn(agentRun, "runAgent").mockResolvedValue(OUTCOME);

    // When
    await runOnce({ ...DEPS, maxBudgetUsd: 0.1 });

    // Then
    expect(spawned.mock.calls[0]![0].maxBudgetUsd).toBe(0.1);
  });

  it("should hand the spawned run the pinned principal and the same build's server", async () => {
    // Given
    harness([{ id: "job-1", kind: JobKind.AGENT_SELFTEST, payload_json: "{}" }]);
    const spawned = vi.spyOn(agentRun, "runAgent").mockResolvedValue(OUTCOME);

    // When
    await runOnce(DEPS);

    // Then
    const spec = spawned.mock.calls[0]![0];
    expect(spec.client).toBe("cerebrium-runner");
    expect(spec.server.args).toEqual(["/x/server.js"]);
  });

  it("should fail the job rather than hold its lease when it claims a kind it cannot run", async () => {
    // Given
    const calls = harness([{ id: "job-1", kind: "agent.unknown", payload_json: "{}" }]);
    const spawned = vi.spyOn(agentRun, "runAgent");

    // When
    await runOnce(DEPS);

    // Then
    expect(spawned).not.toHaveBeenCalled();

    const finish = calls.find((c) => c.method === "job_finish");
    expect((finish?.params.report as { error: string }).error).toContain("no task registered");
  });

  it("should report a failure rather than throw when the spawn itself blows up", async () => {
    // Given
    const calls = harness([{ id: "job-1", kind: JobKind.AGENT_SELFTEST, payload_json: "{}" }]);
    vi.spyOn(agentRun, "runAgent").mockRejectedValue(new Error("cli exploded"));

    // When
    const did = await runOnce(DEPS);

    // Then
    expect(did).toBe("ran");
    const finish = calls.find((c) => c.method === "job_finish");
    expect((finish?.params.report as { error: string }).error).toBe("cli exploded");
  });

  it("should run one job at a time and stop when told to", async () => {
    // Given — two queued, and a stop after the second pass.
    harness([
      { id: "job-1", kind: JobKind.AGENT_SELFTEST, payload_json: "{}" },
      { id: "job-2", kind: JobKind.AGENT_SELFTEST, payload_json: "{}" },
    ]);

    let inFlight = 0;
    let maxInFlight = 0;

    vi.spyOn(agentRun, "runAgent").mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;

      return OUTCOME;
    });

    let passes = 0;

    // When
    await runLoop({
      ...DEPS,
      idleMs: 1,
      sleepMs: () => Promise.resolve(),
      stopped: () => ++passes > 4,
    });

    // Then
    expect(maxInFlight).toBe(1);
  });
});

describe("runner refuses to spawn blind", () => {
  it("should fail the job without spawning when the server path is not a .js bundle", async () => {
    // Given — what resolveServerPath returns when run from source.
    const calls = harness([{ id: "job-1", kind: JobKind.AGENT_SELFTEST, payload_json: "{}" }]);
    const spawned = vi.spyOn(agentRun, "runAgent");

    // When
    await runOnce({ ...DEPS, serverPath: "/repo/src/server.ts" });

    // Then
    expect(spawned).not.toHaveBeenCalled();
    expect(
      (calls.find((c) => c.method === "job_finish")?.params.report as { error: string }).error,
    ).toContain("not a .js bundle");
  });

  it("should call a clean exit a failure when the task cannot use the result", async () => {
    // Given — the run exits 0 having reached no tools, which is what actually happened live.
    const calls = harness([{ id: "job-1", kind: JobKind.AGENT_SELFTEST, payload_json: "{}" }]);

    vi.spyOn(agentRun, "runAgent").mockResolvedValue({
      ...OUTCOME,
      result: '{"session":"session_start tool not available via ToolSearch","hits":0}',
    });

    // When
    await runOnce(DEPS);

    // Then
    const report = calls.find((c) => c.method === "job_finish")?.params.report as {
      exit: string;
      error: string;
      cost_usd: number;
    };

    expect(report.exit).toBe("failed");
    expect(report.error).toContain("unusable result");
    // The spend still happened and is still recorded.
    expect(report.cost_usd).toBe(0.05);
  });
});

describe("runner schedule", () => {
  it("should ask the daemon to queue every recurring task, with its own cadence", async () => {
    // Given
    const calls = harness([]);

    // When
    await scheduleDue({ socketPath: DEPS.socketPath, log: () => undefined });

    // Then
    const enqueued = calls.filter((c) => c.method === "job_enqueue");

    expect(enqueued).toHaveLength(RECURRING_TASKS.length);

    for (const task of RECURRING_TASKS) {
      const sent = enqueued.find((c) => c.params.kind === task.kind);

      expect(sent!.params.every_ms).toBe(task.everyMs);
    }
  });

  it("should never send a prompt with the job, only its kind", async () => {
    // Given
    const calls = harness([]);

    // When
    await scheduleDue({ socketPath: DEPS.socketPath, log: () => undefined });

    // Then
    for (const call of calls.filter((c) => c.method === "job_enqueue")) {
      expect(Object.keys(call.params).sort()).toEqual(["every_ms", "kind"]);
    }
  });

  it("should count nothing as queued when the daemon says the kind is not due", async () => {
    // Given
    vi.spyOn(rpc, "rpcCall").mockResolvedValue(null);

    // When
    const queued = await scheduleDue({ socketPath: DEPS.socketPath, log: () => undefined });

    // Then
    expect(queued).toBe(0);
  });

  it("should carry on when the daemon refuses a kind, rather than take the loop down", async () => {
    // Given
    const logged: string[] = [];

    vi.spyOn(rpc, "rpcCall").mockRejectedValue(new Error("not an agent job"));

    // When
    const queued = await scheduleDue({
      socketPath: DEPS.socketPath,
      log: (line) => logged.push(line),
    });

    // Then
    expect(queued).toBe(0);
    expect(logged.join(" ")).toContain("could not schedule");
  });

  it("should schedule before it claims, so a first-ever loop has something to pick up", async () => {
    // Given
    const calls = harness([]);

    // When
    await runLoop({
      ...DEPS,
      idleMs: 0,
      stopped: (() => {
        let passes = 0;

        return () => passes++ > 0;
      })(),
      sleepMs: () => Promise.resolve(),
    });

    // Then
    expect(calls[0]!.method).toBe("job_enqueue");
    expect(calls.some((c) => c.method === "job_claim")).toBe(true);
  });
});
