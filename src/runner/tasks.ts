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
  // How often the runner enqueues this task for itself. Absent means it only ever runs when
  // an operator asks for it with `--once`.
  everyMs?: number;
  prompt: (ctx: TaskContext, payload: Record<string, unknown>) => Promise<string>;
  // Judges the run's own output. Returns null when it is usable, or why it is not.
  // A clean exit is not evidence of work: a run whose MCP server failed to start exits 0
  // having answered from nothing, which is how the first live self-test "succeeded" while
  // reaching no tools at all.
  verify: (result: string | null) => string | null;
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

// The model is told to answer with one line of JSON and mostly does, but it may fence it or
// pad it with a sentence. Take the last balanced object in the reply and parse that.
export function parseReply(result: string): Record<string, unknown> | null {
  const end = result.lastIndexOf("}");

  if (end < 0) return null;

  for (
    let start = result.indexOf("{");
    start >= 0 && start < end;
    start = result.indexOf("{", start + 1)
  ) {
    try {
      const parsed: unknown = JSON.parse(result.slice(start, end + 1));

      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }

  return null;
}

// Names which of the two failures it was. "the model answered something else" and "the
// model answered a session it made up" are different faults with different fixes, and a
// single message for both loses the one an operator needs.
function sessionProblem(reply: Record<string, unknown>): string | null {
  const session = reply.session;

  if (typeof session !== "string" || !session.length) return "no session in the reply";

  return ULID.test(session) ? null : `session is not an id: ${session.slice(0, 60)}`;
}

// Proves the loop and nothing else: spawn, reach Cerebrium under the pinned identity, do one
// read, come back with a parseable answer, and report what it cost. It writes nothing, so
// arming it risks a few cents and no content.
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

    const reply = parseReply(result);

    return reply === null ? "no session in the reply" : sessionProblem(reply);
  },
};

// A fixed query returns a fixed candidate set, and the model then picks the same note every
// run: the first two live runs drew four edges off one note between them.
const CANDIDATE_QUERIES: readonly string[] = [
  "how this code works, why it is shaped this way, the gotcha a later editor hits",
  "a trap in the runtime that bit us, and the ordering constraint behind it",
  "what a service does when it fails, and what it does instead of failing",
  "how the store is read: ranking, retrieval, and what the query actually matches",
  "the daemon, its lifetime, and what supervises it",
  "a schema or migration decision and what it made impossible afterwards",
  "how one process talks to another here, and what the boundary refuses",
];

export function candidateQuery(dayIndex: number): string {
  const size = CANDIDATE_QUERIES.length;

  return CANDIDATE_QUERIES[((dayIndex % size) + size) % size]!;
}

const DAY_MS = 86_400_000;

const MAX_EDGES = 3;

interface Envelope {
  id: string;
  title: string;
}

// The half of the note→code join the sweep structurally cannot reach. Its `documents`
// proposal fires only on a backticked citation inside one repo — measured at 691 candidates
// against 58 live edges — so a note that plainly describes a piece of code without ever
// quoting its name is invisible to it. This task reads such a note and finds the symbol by
// meaning instead. Every edge it draws is authored by the `cerebrium-runner` principal, so
// `write: suggest` marks each one for review and the weight discounts it at read time.
const DOCUMENTS: AgentTask = {
  kind: JobKind.AGENT_DOCUMENTS,
  model: "haiku",
  allowedTools: [
    "mcp__cerebrium__session_start",
    "mcp__cerebrium__search",
    "mcp__cerebrium__get",
    "mcp__cerebrium__link",
  ],
  maxBudgetUsd: 0.5,
  timeoutMs: 600_000,
  writes: true,
  everyMs: 86_400_000,
  prompt: async (ctx) => {
    const found = (await ctx.call("search_memory", {
      query: candidateQuery(Math.floor(Date.now() / DAY_MS)),
      project: "cerebrium",
      kinds: ["semantic"],
      types: ["fact", "howto", "decision"],
      limit: 8,
    })) as { results?: Envelope[] };

    const candidates = (found.results ?? []).filter(
      (r) => typeof r.id === "string" && typeof r.title === "string",
    );

    if (!candidates.length) {
      throw new Error("no candidate notes came back; nothing to propose an edge for");
    }

    return [
      "You are extending Cerebrium's note-to-code index.",
      "Cerebrium's background sweep can only propose a `documents` edge when a note cites a",
      "symbol in backticks. Your job is the rest: a note that plainly describes a piece of",
      "code without ever quoting its name.",
      "",
      "Steps:",
      "1. Call session_start with project 'cerebrium'. Keep the session_id it returns.",
      "2. Pick ONE note from the candidates below and call get on it. Read what it claims.",
      "   Prefer a note carrying NO `documents` edge yet. A note that already has one has",
      "   been covered; move to the next candidate rather than hanging more edges off it.",
      "3. Find the code it describes: call search with types ['symbol'] and a query drawn",
      "   from the note's own subject. Never invent an id — use only ids a tool returned.",
      "4. The get in step 2 listed that note's existing edges. If the symbol is already",
      "   linked to it, choose a different symbol or a different note.",
      "5. Only when the note genuinely explains that symbol, call link with type 'documents',",
      `   src = the note id, dst = the symbol id. At most ${String(MAX_EDGES)} edges.`,
      "6. If none of the candidates is a genuine match, link nothing. That is a correct",
      "   outcome and you should report it as an empty list.",
      "",
      "Do not write, update or invalidate anything. `link` is the only change you may make.",
      "",
      "Candidates:",
      ...candidates.map((c) => `- ${c.id} — ${c.title}`),
      "",
      "Reply with ONLY one line of JSON and no other text:",
      '{"session":"<session_id>","note":"<the note id you worked on>",' +
        '"edges":[{"symbol":"<symbol id you linked>","why":"<at most 10 words>"}]}',
      'An empty "edges" list is valid. Do not report an edge you did not successfully link.',
    ].join("\n");
  },
  verify: (result) => {
    if (result === null) return "no reply";

    const reply = parseReply(result);

    if (reply === null) return "no JSON in the reply";

    const problem = sessionProblem(reply);

    if (problem !== null) return problem;

    // An empty list is the honest answer when nothing matched, but the key has to be there:
    // its absence is a run that never got as far as deciding.
    if (!Array.isArray(reply.edges)) return "no edges list in the reply";

    const edges = reply.edges as unknown[];

    if (edges.length > MAX_EDGES) {
      return `reported ${String(edges.length)} edges, cap is ${String(MAX_EDGES)}`;
    }

    const named = (edge: unknown): boolean =>
      typeof edge === "object" &&
      edge !== null &&
      ULID.test(String((edge as { symbol?: unknown }).symbol));

    return edges.every(named) ? null : "an edge names no symbol id";
  },
};

const TASKS: readonly AgentTask[] = [SELFTEST, DOCUMENTS];

export const TASK_KINDS: readonly string[] = TASKS.map((t) => t.kind);

// What the runner enqueues for itself on the loop. `--once` reaches every task; only these
// ever run unattended.
export const RECURRING_TASKS: readonly (AgentTask & { everyMs: number })[] = TASKS.filter(
  (t): t is AgentTask & { everyMs: number } => t.everyMs !== undefined,
);

export function taskFor(kind: string): AgentTask | undefined {
  return TASKS.find((t) => t.kind === kind);
}
