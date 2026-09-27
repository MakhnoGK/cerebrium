import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

interface ToolCall {
  step: number;
  name: string;
  source: "cerebrium" | "host";
  args: Record<string, unknown> | null;
  argumentsObservable: boolean;
}

export interface TraceAudit {
  observability: "complete" | "partial" | "unobservable";
  observedCalls: number;
  cerebriumCalls: Record<string, number>;
  hostCalls: Record<string, number>;
  lifecycle: "yes" | "no" | "unknown" | "not-applicable";
  searchBeforeWrite: { yes: number; no: number; unknown: number };
  codeLookupBeforeFileNavigation: "yes" | "no" | "unknown" | "not-applicable";
  writes: {
    observed: number;
    argumentsObservable: number;
    parentAttached: number;
    parentNull: number;
    parentMissing: number;
    inlineLinks: number;
  };
  linkCalls: number;
  checkpoints: number;
  hookInjections: number;
}

export interface AggregateAudit {
  mode: "historical";
  totalsAreLowerBounds: boolean;
  transcripts: number;
  complete: number;
  partial: number;
  unobservable: number;
  observedCalls: number;
  cerebriumCalls: Record<string, number>;
  hostCalls: Record<string, number>;
  lifecycle: Record<TraceAudit["lifecycle"], number>;
  searchBeforeWrite: { yes: number; no: number; unknown: number };
  codeLookupBeforeFileNavigation: Record<TraceAudit["codeLookupBeforeFileNavigation"], number>;
  writes: TraceAudit["writes"];
  linkCalls: number;
  checkpoints: number;
  hookInjections: number;
}

const FILE_NAVIGATION = new Set(["view_file", "grep_search", "list_dir"]);
const NAVIGATION_PATH_FIELD: Record<string, string> = {
  view_file: "AbsolutePath",
  grep_search: "SearchPath",
  list_dir: "DirectoryPath",
};
const HOOK_REMINDER = "Call `session_start` before any other memory tool";
const HELP = `
agent-trace-audit — aggregate privacy-safe Antigravity memory behavior from transcript JSONL.

  npm run eval:agents -- [options]

  --root PATH  Scan one alternate transcript root instead of the IDE and CLI defaults.
  --json       Emit the aggregate as JSON.
  --help       Show this text.

Historical results are descriptive only. Truncated or malformed tool-call rows make totals
observed lower bounds; no prompts, argument values, ids, or transcript paths are printed.
This command intentionally emits no thresholds or pass/fail verdicts; fresh labeled scenario
evaluation is a separate manual follow-up.
`;

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function decodedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith('"')) return value;
  try {
    const decoded: unknown = JSON.parse(value);
    return typeof decoded === "string" ? decoded : null;
  } catch {
    return null;
  }
}

function decodedArguments(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return object(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return object(value);
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function strictlyBefore(
  calls: ToolCall[],
  earlier: string,
  later: ToolCall,
): "yes" | "no" | "unknown" {
  const steps = calls.filter((call) => call.name === earlier).map((call) => call.step);
  if (steps.some((step) => step < later.step)) return "yes";
  if (steps.some((step) => step === later.step)) return "unknown";
  return "no";
}

function codeNavigation(call: ToolCall): boolean | null {
  if (!FILE_NAVIGATION.has(call.name)) return false;
  const field = NAVIGATION_PATH_FIELD[call.name];
  const path = field === undefined || call.args === null ? null : decodedString(call.args[field]);
  if (path === null) return null;
  if (path.includes("/.system_generated/")) return false;
  const file = basename(path);
  if (["SKILL.md", "AGENTS.md", "GEMINI.md", "CLAUDE.md"].includes(file)) return false;
  return true;
}

export function auditTranscript(text: string): TraceAudit {
  const calls: ToolCall[] = [];
  let partial = false;
  let sawToolCallArray = false;
  let hookInjections = 0;

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let row: Record<string, unknown> | null;
    try {
      row = object(JSON.parse(line));
    } catch {
      partial = true;
      continue;
    }
    if (row === null) {
      partial = true;
      continue;
    }
    if (row.type === "EPHEMERAL_MESSAGE" && typeof row.content === "string") {
      if (row.content.includes(HOOK_REMINDER)) hookInjections++;
    }
    if (row.type !== "PLANNER_RESPONSE") continue;
    const truncated =
      Array.isArray(row.truncated_fields) && row.truncated_fields.includes("tool_calls");
    if (truncated) partial = true;
    if (row.tool_calls === undefined) continue;
    if (!Array.isArray(row.tool_calls) || typeof row.step_index !== "number") {
      partial = true;
      continue;
    }
    sawToolCallArray = true;
    for (const rawCall of row.tool_calls) {
      const call = object(rawCall);
      if (call === null || typeof call.name !== "string") {
        partial = true;
        continue;
      }
      if (call.name !== "call_mcp_tool") {
        calls.push({
          step: row.step_index,
          name: call.name,
          source: "host",
          args: object(call.args),
          argumentsObservable: !truncated,
        });
        continue;
      }
      const encoded = object(call.args);
      if (encoded === null) {
        partial = true;
        continue;
      }
      const server = decodedString(encoded.ServerName);
      const name = decodedString(encoded.ToolName);
      if (server === null || name === null) {
        partial = true;
        continue;
      }
      if (server !== "cerebrium") continue;
      const args = decodedArguments(encoded.Arguments);
      const argumentsObservable = !truncated && args !== null;
      if (!argumentsObservable) partial = true;
      calls.push({
        step: row.step_index,
        name,
        source: "cerebrium",
        args,
        argumentsObservable,
      });
    }
  }

  const cerebrium = calls.filter((call) => call.source === "cerebrium");
  const host = calls.filter((call) => call.source === "host");
  const cerebriumCalls: Record<string, number> = {};
  const hostCalls: Record<string, number> = {};
  for (const call of cerebrium) increment(cerebriumCalls, call.name);
  for (const call of host) increment(hostCalls, call.name);

  const observability: TraceAudit["observability"] = !sawToolCallArray
    ? "unobservable"
    : partial
      ? "partial"
      : "complete";
  const uncertain = observability !== "complete";

  let lifecycle: TraceAudit["lifecycle"] = uncertain ? "unknown" : "not-applicable";
  if (cerebrium.length > 0 && uncertain) {
    lifecycle = "unknown";
  } else if (cerebrium.length > 0) {
    const firstStep = Math.min(...cerebrium.map((call) => call.step));
    const first = cerebrium.filter((call) => call.step === firstStep).map((call) => call.name);
    lifecycle =
      first.length === 1 && first[0] === "session_start"
        ? "yes"
        : first.includes("session_start")
          ? "unknown"
          : "no";
  }

  const searchBeforeWrite = { yes: 0, no: 0, unknown: 0 };
  const writes = cerebrium.filter((call) => call.name === "write");
  for (const write of writes) {
    increment(
      searchBeforeWrite,
      uncertain ? "unknown" : strictlyBefore(cerebrium, "search", write),
    );
  }

  const navigation = host.map((call) => ({ call, code: codeNavigation(call) }));
  const fileNavigation = navigation
    .filter((entry) => entry.code === true)
    .map((entry) => entry.call);
  const navigationUnknown = navigation.some((entry) => entry.code === null);
  let codeLookupBeforeFileNavigation: TraceAudit["codeLookupBeforeFileNavigation"] = uncertain
    ? "unknown"
    : "not-applicable";
  if (navigationUnknown || (fileNavigation.length > 0 && uncertain)) {
    codeLookupBeforeFileNavigation = "unknown";
  } else if (fileNavigation.length > 0) {
    const firstStep = Math.min(...fileNavigation.map((call) => call.step));
    const first = fileNavigation.find((call) => call.step === firstStep)!;
    codeLookupBeforeFileNavigation = strictlyBefore(cerebrium, "code_lookup", first);
  }

  const writeMetrics: TraceAudit["writes"] = {
    observed: writes.length,
    argumentsObservable: 0,
    parentAttached: 0,
    parentNull: 0,
    parentMissing: 0,
    inlineLinks: 0,
  };
  for (const write of writes) {
    if (!write.argumentsObservable || write.args === null) continue;
    writeMetrics.argumentsObservable++;
    if (!("parent_node_id" in write.args)) writeMetrics.parentMissing++;
    else if (write.args.parent_node_id === null) writeMetrics.parentNull++;
    else writeMetrics.parentAttached++;
    if (Array.isArray(write.args.links)) writeMetrics.inlineLinks += write.args.links.length;
  }

  return {
    observability,
    observedCalls: calls.length,
    cerebriumCalls,
    hostCalls,
    lifecycle,
    searchBeforeWrite,
    codeLookupBeforeFileNavigation,
    writes: writeMetrics,
    linkCalls: cerebriumCalls.link ?? 0,
    checkpoints: cerebriumCalls.checkpoint ?? 0,
    hookInjections,
  };
}

export function aggregateAudits(audits: TraceAudit[]): AggregateAudit {
  const result: AggregateAudit = {
    mode: "historical",
    totalsAreLowerBounds: audits.some((audit) => audit.observability !== "complete"),
    transcripts: audits.length,
    complete: audits.filter((audit) => audit.observability === "complete").length,
    partial: audits.filter((audit) => audit.observability === "partial").length,
    unobservable: audits.filter((audit) => audit.observability === "unobservable").length,
    observedCalls: 0,
    cerebriumCalls: {},
    hostCalls: {},
    lifecycle: { yes: 0, no: 0, unknown: 0, "not-applicable": 0 },
    searchBeforeWrite: { yes: 0, no: 0, unknown: 0 },
    codeLookupBeforeFileNavigation: { yes: 0, no: 0, unknown: 0, "not-applicable": 0 },
    writes: {
      observed: 0,
      argumentsObservable: 0,
      parentAttached: 0,
      parentNull: 0,
      parentMissing: 0,
      inlineLinks: 0,
    },
    linkCalls: 0,
    checkpoints: 0,
    hookInjections: 0,
  };
  for (const audit of audits) {
    result.observedCalls += audit.observedCalls;
    result.lifecycle[audit.lifecycle]++;
    result.codeLookupBeforeFileNavigation[audit.codeLookupBeforeFileNavigation]++;
    for (const [name, count] of Object.entries(audit.cerebriumCalls)) {
      result.cerebriumCalls[name] = (result.cerebriumCalls[name] ?? 0) + count;
    }
    for (const [name, count] of Object.entries(audit.hostCalls)) {
      result.hostCalls[name] = (result.hostCalls[name] ?? 0) + count;
    }
    for (const key of ["yes", "no", "unknown"] as const) {
      result.searchBeforeWrite[key] += audit.searchBeforeWrite[key];
    }
    for (const key of Object.keys(result.writes) as (keyof TraceAudit["writes"])[]) {
      result.writes[key] += audit.writes[key];
    }
    result.linkCalls += audit.linkCalls;
    result.checkpoints += audit.checkpoints;
    result.hookInjections += audit.hookInjections;
  }
  return result;
}

function transcripts(root: string): string[] {
  const found: string[] = [];
  function walk(path: string): void {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && basename(child) === "transcript.jsonl") found.push(child);
    }
  }
  walk(root);
  return found.sort();
}

function printHuman(audit: AggregateAudit): void {
  const qualifier = audit.totalsAreLowerBounds ? "observed lower bounds" : "exact observations";
  process.stdout.write("Antigravity historical trace audit\n");
  process.stdout.write(
    `${audit.transcripts} transcripts: ${audit.complete} complete, ${audit.partial} partial, ` +
      `${audit.unobservable} unobservable; ${qualifier}.\n`,
  );
  process.stdout.write(`Observed tool calls: ${audit.observedCalls}\n`);
  process.stdout.write(`Cerebrium: ${JSON.stringify(audit.cerebriumCalls)}\n`);
  process.stdout.write(`Lifecycle first-call: ${JSON.stringify(audit.lifecycle)}\n`);
  process.stdout.write(`Search before write: ${JSON.stringify(audit.searchBeforeWrite)}\n`);
  process.stdout.write(`Writes: ${JSON.stringify(audit.writes)}\n`);
  process.stdout.write(
    `Code lookup before file navigation: ${JSON.stringify(audit.codeLookupBeforeFileNavigation)}\n`,
  );
  process.stdout.write(`Link calls: ${audit.linkCalls}; checkpoints: ${audit.checkpoints}\n`);
  process.stdout.write(
    "Historical traces are descriptive; they do not receive a compliance verdict.\n",
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  const json = process.argv.includes("--json");
  const rootIndex = process.argv.indexOf("--root");
  const roots =
    rootIndex === -1
      ? [join(homedir(), ".gemini", "antigravity"), join(homedir(), ".gemini", "antigravity-cli")]
      : [resolve(process.argv[rootIndex + 1] ?? ".")];
  const files = roots.flatMap(transcripts);
  const audit = aggregateAudits(files.map((path) => auditTranscript(readFileSync(path, "utf8"))));
  if (json) process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
  else printHuman(audit);
}

if (process.env.VITEST === undefined) await main();
