import { JobKind } from "@/core/vocab";

// What the runner may be asked to run, and on what terms. Every task is declared here, in
// code — a job row carries only its kind and a small payload, never a prompt. If prompts
// travelled in payloads, enqueueing a job would be enqueueing instructions, and the only
// thing standing between that and arbitrary agent behaviour would be who can write a row.

export interface TaskContext {
  // Reads against the live store through the daemon, as the runner host. A task builds its
  // prompt from memory rather than from nothing — that is the whole point of running these
  // here instead of in a stateless cron.
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface AgentTask {
  kind: string;
  // Cheap by default and always explicit. A task that genuinely needs judgement can say so;
  // none does yet.
  model: string;
  // Exhaustive: `--strict-mcp-config` means the run sees only Cerebrium, and this names
  // which of its tools are pre-approved. Everything else is refused.
  allowedTools: readonly string[];
  maxBudgetUsd: number;
  timeoutMs: number;
  // Whether the run is expected to write. Recorded on the run so a reader can tell a task
  // that was supposed to be read-only from one that was not.
  writes: boolean;
  prompt: (ctx: TaskContext, payload: Record<string, unknown>) => Promise<string>;
  // Judges the run's own output. Returns null when it is usable, or why it is not.
  // A clean exit is not evidence of work: a run whose MCP server failed to start exits 0
  // having answered from nothing, which is how the first live self-test "succeeded" while
  // reaching no tools at all.
  verify: (result: string | null) => string | null;
}

// Proves the loop and nothing else: spawn, reach Cerebrium under the pinned identity, do one
// read, come back with a parseable answer, and report what it cost. It writes nothing, so
// arming it risks a few cents and no content. This is what ships enabled; the first task
// that actually writes is a separate decision.
const SELFTEST: AgentTask = {
  kind: JobKind.AGENT_SELFTEST,
  model: "haiku",
  allowedTools: ["mcp__cerebrium__session_start", "mcp__cerebrium__search"],
  maxBudgetUsd: 0.25,
  timeoutMs: 120_000,
  writes: false,
  prompt: () =>
    Promise.resolve(
      [
        "Call the cerebrium session_start tool with project 'cerebrium'.",
        "Then call the cerebrium search tool with query 'consolidation sweep' and limit 1.",
        "Reply with ONLY one line of JSON and no other text:",
        '{"session":"<the session_id you got>","hits":<how many results search returned>}',
        "Do not write, update, or link anything.",
      ].join(" "),
    ),
  verify: (result) => {
    if (result === null) return "no reply";

    // The model may fence the JSON; the check is about whether it reached the tools, not
    // about whether it followed formatting to the letter.
    const match = /\{[^{}]*"session"\s*:\s*"([^"]*)"[^{}]*\}/.exec(result);

    if (match === null) return "no session in the reply";

    return /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(match[1]!)
      ? null
      : `session is not an id: ${match[1]!.slice(0, 60)}`;
  },
};

const TASKS: readonly AgentTask[] = [SELFTEST];

export const TASK_KINDS: readonly string[] = TASKS.map((t) => t.kind);

export function taskFor(kind: string): AgentTask | undefined {
  return TASKS.find((t) => t.kind === kind);
}
