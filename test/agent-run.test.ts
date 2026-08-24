import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildArgs,
  DENIED_TOOLS,
  parseEnvelope,
  runAgent,
  type AgentRunSpec,
  type Spawner,
} from "@/runtime/agent-run";

const SPEC: AgentRunSpec = {
  prompt: "say hello",
  model: "haiku",
  allowedTools: ["mcp__cerebrium__search"],
  maxBudgetUsd: 0.5,
  timeoutMs: 1000,
  cwd: "/tmp",
  client: "cerebrium-runner",
  server: { command: "/opt/homebrew/bin/node", args: ["/x/server.js"], env: { A: "1" } },
};

const ENVELOPE = JSON.stringify({
  is_error: false,
  result: "hello",
  total_cost_usd: 0.0554,
  num_turns: 3,
  usage: {
    input_tokens: 6,
    output_tokens: 173,
    cache_creation_input_tokens: 33677,
    cache_read_input_tokens: 52731,
  },
  modelUsage: { "claude-haiku-4-5-20251001": {} },
  permission_denials: [],
});

// A child that emits what a real one would, without a process behind it.
function fakeChild(opts: {
  stdout?: string;
  stderr?: string;
  code?: number;
  hang?: boolean;
}): ChildProcess {
  const child = new EventEmitter() as ChildProcess & { killed: string[] };
  const out = new EventEmitter();
  const err = new EventEmitter();

  Object.assign(child, {
    stdout: out,
    stderr: err,
    killed: [],
    kill(signal?: string) {
      (child as unknown as { killed: string[] }).killed.push(signal ?? "SIGTERM");
      // A killed child still closes; a hanging one only closes once killed.
      setImmediate(() => child.emit("close", null));

      return true;
    },
  });

  setImmediate(() => {
    if (opts.stdout) out.emit("data", Buffer.from(opts.stdout));
    if (opts.stderr) err.emit("data", Buffer.from(opts.stderr));
    if (!opts.hang) child.emit("close", opts.code ?? 0);
  });

  return child;
}

const spawnerFor =
  (child: ChildProcess): Spawner =>
  () =>
    child;

describe("buildArgs", () => {
  it("should restrict the run to the one server it is handed when it builds the command", () => {
    // Given / When
    const args = buildArgs(SPEC, "/tmp/mcp.json");

    // Then
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/tmp/mcp.json");
  });

  it("should always pin a model and a budget when it builds the command", () => {
    // Given / When
    const args = buildArgs(SPEC, "/tmp/mcp.json");

    // Then
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("0.5");
  });

  it("should refuse the dangerous built-ins rather than merely not approving them", () => {
    // Given / When
    const args = buildArgs(SPEC, "/tmp/mcp.json");

    // Then
    expect(args).toContain("--disallowedTools");
    for (const tool of DENIED_TOOLS) expect(args).toContain(tool);
  });
});

describe("parseEnvelope", () => {
  it("should take the last parseable object when the stream carries noise ahead of it", () => {
    // Given / When
    const parsed = parseEnvelope(`warming up\nnot json\n${ENVELOPE}`);

    // Then
    expect(parsed?.total_cost_usd).toBe(0.0554);
  });

  it("should report nothing rather than throw when no line parses", () => {
    // Given / When / Then
    expect(parseEnvelope("total gibberish")).toBeNull();
  });
});

describe("runAgent", () => {
  it("should report the run's cost and usage when it completes", async () => {
    // Given
    const child = fakeChild({ stdout: ENVELOPE, code: 0 });

    // When
    const out = await runAgent(SPEC, { spawner: spawnerFor(child) });

    // Then
    expect(out.exit).toBe("completed");
    expect(out.result).toBe("hello");
    expect(out.cost_usd).toBe(0.0554);
    expect(out.turns).toBe(3);
    expect(out.usage?.cache_read_input_tokens).toBe(52731);
    expect(out.model).toBe("claude-haiku-4-5-20251001");
    expect(out.error).toBeNull();
  });

  it("should report a failure with the CLI's stderr when the process exits nonzero", async () => {
    // Given
    const child = fakeChild({ stderr: "model unavailable", code: 1 });

    // When
    const out = await runAgent(SPEC, { spawner: spawnerFor(child) });

    // Then
    expect(out.exit).toBe("failed");
    expect(out.error).toContain("model unavailable");
  });

  it("should treat an is_error envelope as a failure even on exit 0", async () => {
    // Given
    const child = fakeChild({
      stdout: JSON.stringify({ is_error: true, result: "nope" }),
      code: 0,
    });

    // When
    const out = await runAgent(SPEC, { spawner: spawnerFor(child) });

    // Then
    expect(out.exit).toBe("failed");
  });

  it("should kill a run that outlives its cap and still report it as a timeout", async () => {
    // Given
    const child = fakeChild({ hang: true });

    // When
    const out = await runAgent({ ...SPEC, timeoutMs: 20 }, { spawner: spawnerFor(child) });

    // Then
    expect(out.exit).toBe("timeout");
    expect((child as unknown as { killed: string[] }).killed).toContain("SIGTERM");
  });

  it("should still record the cost of a run that timed out after printing its envelope", async () => {
    // Given — the envelope arrives, the process then refuses to exit.
    const child = fakeChild({ stdout: ENVELOPE, hang: true });

    // When
    const out = await runAgent({ ...SPEC, timeoutMs: 20 }, { spawner: spawnerFor(child) });

    // Then
    expect(out.exit).toBe("timeout");
    expect(out.cost_usd).toBe(0.0554);
  });

  it("should hand the run exactly one server, pinned to the runner principal, and delete the config afterwards", async () => {
    // Given — read the config while the child is "running", since it is removed on return.
    const child = fakeChild({ stdout: ENVELOPE, code: 0 });
    let written: { path: string; body: unknown } | null = null;

    const spawner: Spawner = (_cmd, args) => {
      const path = args[args.indexOf("--mcp-config") + 1]!;

      written = { path, body: JSON.parse(readFileSync(path, "utf8")) };

      return child;
    };

    // When
    await runAgent(SPEC, { spawner });

    // Then
    const seen = written as unknown as { path: string; body: Record<string, never> };
    const servers = (
      seen.body as unknown as { mcpServers: Record<string, { env: Record<string, string> }> }
    ).mcpServers;

    expect(Object.keys(servers)).toEqual(["cerebrium"]);
    expect(servers.cerebrium!.env.MEMORY_CLIENT).toBe("cerebrium-runner");
    expect(servers.cerebrium!.env.A).toBe("1");
    expect(existsSync(seen.path)).toBe(false);
  });

  it("should report a spawn failure rather than throw when the CLI is not there", async () => {
    // Given
    const spawner: Spawner = () => {
      throw new Error("ENOENT claude");
    };

    // When
    const out = await runAgent(SPEC, { spawner });

    // Then
    expect(out.exit).toBe("spawn_failed");
    expect(out.error).toContain("ENOENT");
  });
});
