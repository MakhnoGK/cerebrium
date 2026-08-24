import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs one external agent CLI headlessly and reports what it cost. Nothing here decides
// WHAT to run — the prompt and the tool allowance come from the caller, and the caller's
// prompts live in code rather than in job payloads, so a queued job can never carry
// instructions of its own.

// Built-ins the runner never grants. A task that needs one has to say so explicitly, and
// none does today. `--allowedTools` pre-approves; this is the half that refuses, because a
// tool that is merely un-approved would still be offered and merely fail late.
export const DENIED_TOOLS: readonly string[] = [
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
];

export interface AgentRunSpec {
  prompt: string;
  // Always explicit. Inheriting the session default costs 6.6x for identical work
  // (measured 2026-08-23: $0.3675 Opus vs $0.0554 Haiku on the same trivial run).
  model: string;
  allowedTools: readonly string[];
  // Hard ceiling the CLI enforces itself, independent of our wall clock.
  maxBudgetUsd: number;
  timeoutMs: number;
  cwd: string;
  // The principal the spawned agent writes as. Pinned through the MCP entry's own env,
  // which only this host can set — see S4b.
  client: string;
  // The one MCP server the run may see. `--strict-mcp-config` makes this exhaustive, so the
  // agent cannot reach the owner's other servers or their credentials.
  server: { command: string; args: string[]; env: Record<string, string> };
}

export type AgentExit = "completed" | "failed" | "timeout" | "spawn_failed";

export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface AgentRunOutcome {
  exit: AgentExit;
  // The agent's final text, which its prompt defines the meaning of.
  result: string | null;
  // What the run drew from the owner's subscription, as the CLI computed it. Recorded on
  // every run: without it "what did the runner spend this week" is unanswerable.
  cost_usd: number | null;
  usage: AgentUsage | null;
  turns: number | null;
  duration_ms: number;
  model: string | null;
  permission_denials: number;
  error: string | null;
}

interface CliEnvelope {
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: Partial<AgentUsage>;
  modelUsage?: Record<string, unknown>;
  permission_denials?: unknown[];
  subtype?: string;
}

const MAX_ERROR_CHARS = 500;
const SIGKILL_GRACE_MS = 5_000;

// The CLI prints one JSON object per run under `--output-format json`, but stderr and any
// stray stdout line must not break the parse: take the last line that parses as an object.
export function parseEnvelope(stdout: string): CliEnvelope | null {
  const lines = stdout.trim().split("\n").reverse();

  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);

      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return null;
}

export function buildArgs(spec: AgentRunSpec, mcpConfigPath: string): string[] {
  return [
    "-p",
    spec.prompt,
    "--output-format",
    "json",
    "--model",
    spec.model,
    "--mcp-config",
    mcpConfigPath,
    // Without this the run inherits every MCP server the owner has configured, credentials
    // and all. The allowance below would still be about tools, not about reach.
    "--strict-mcp-config",
    "--max-budget-usd",
    String(spec.maxBudgetUsd),
    ...(spec.allowedTools.length ? ["--allowedTools", ...spec.allowedTools] : []),
    "--disallowedTools",
    ...DENIED_TOOLS,
  ];
}

export type Spawner = (cmd: string, args: string[], opts: { cwd: string }) => ChildProcess;

const defaultSpawn: Spawner = (cmd, args, opts) =>
  spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });

function usageOf(envelope: CliEnvelope): AgentUsage | null {
  const u = envelope.usage;

  if (u === undefined) return null;

  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
  };
}

export async function runAgent(
  spec: AgentRunSpec,
  opts: { cli?: string; spawner?: Spawner; now?: () => number } = {},
): Promise<AgentRunOutcome> {
  const cli = opts.cli ?? "claude";
  const spawner = opts.spawner ?? defaultSpawn;
  const now = opts.now ?? Date.now;
  const started = now();

  // A throwaway config, mode 0600, removed in `finally`: the pinned identity and the
  // server's env live in it, and it must not outlive the run.
  const dir = mkdtempSync(join(tmpdir(), "cerebrium-run-"));
  const configPath = join(dir, "mcp.json");

  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        cerebrium: {
          type: "stdio",
          command: spec.server.command,
          args: spec.server.args,
          env: { ...spec.server.env, MEMORY_CLIENT: spec.client },
        },
      },
    }),
    { mode: 0o600 },
  );

  try {
    return await new Promise<AgentRunOutcome>((resolve) => {
      let child: ChildProcess;

      try {
        child = spawner(cli, buildArgs(spec, configPath), { cwd: spec.cwd });
      } catch (err) {
        resolve({
          exit: "spawn_failed",
          result: null,
          cost_usd: null,
          usage: null,
          turns: null,
          duration_ms: now() - started,
          model: null,
          permission_denials: 0,
          error: (err as Error).message.slice(0, MAX_ERROR_CHARS),
        });

        return;
      }

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

      const kill = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        // A run that ignores SIGTERM still has to stop: the whole point of the cap is that
        // an unattended agent cannot spend the owner's budget indefinitely.
        setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS).unref();
      }, spec.timeoutMs);

      kill.unref();

      const finish = (outcome: AgentRunOutcome) => {
        if (settled) return;

        settled = true;
        clearTimeout(kill);
        resolve(outcome);
      };

      child.on("error", (err) => {
        finish({
          exit: "spawn_failed",
          result: null,
          cost_usd: null,
          usage: null,
          turns: null,
          duration_ms: now() - started,
          model: null,
          permission_denials: 0,
          error: err.message.slice(0, MAX_ERROR_CHARS),
        });
      });

      child.on("close", (code) => {
        const envelope = parseEnvelope(stdout);
        // A timed-out run may still have printed a partial envelope; its cost is real and
        // is recorded even though the run failed.
        const exit: AgentExit = timedOut
          ? "timeout"
          : code === 0 && envelope !== null && envelope.is_error !== true
            ? "completed"
            : "failed";

        finish({
          exit,
          result: envelope?.result ?? null,
          cost_usd: envelope?.total_cost_usd ?? null,
          usage: envelope === null ? null : usageOf(envelope),
          turns: envelope?.num_turns ?? null,
          duration_ms: now() - started,
          model: envelope?.modelUsage ? (Object.keys(envelope.modelUsage)[0] ?? null) : null,
          permission_denials: envelope?.permission_denials?.length ?? 0,
          error:
            exit === "completed"
              ? null
              : (stderr.trim() || `${cli} exited ${String(code)}`).slice(0, MAX_ERROR_CHARS),
        });
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
