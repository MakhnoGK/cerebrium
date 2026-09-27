// Memory envelopes are JSON, and a `get` of a long node can be large enough to hurt the
// context it is supposed to serve. Everything a tool returns passes through `clip`, and the
// transcript shows `summarize` — one line read off the response's shape rather than its tool
// name, so a new tool degrades to a size instead of breaking the row.

export interface Clipped {
  text: string;
  truncated: boolean;
  bytes: number;
  totalBytes: number;
}

export const MAX_RESULT_BYTES = 48_000;
export const MAX_RESULT_LINES = 1_200;

export function clip(
  text: string,
  maxBytes: number = MAX_RESULT_BYTES,
  maxLines: number = MAX_RESULT_LINES,
): Clipped {
  const totalBytes = Buffer.byteLength(text, "utf8");
  const lines = text.split("\n");
  const byLines = lines.length > maxLines ? lines.slice(0, maxLines).join("\n") : text;
  const kept =
    Buffer.byteLength(byLines, "utf8") > maxBytes
      ? Buffer.from(byLines, "utf8").subarray(0, maxBytes).toString("utf8")
      : byLines;
  const truncated = kept.length < text.length;
  return {
    text: truncated ? `${kept}\n\n[clipped by the cerebrium bridge — narrow the call]` : text,
    truncated,
    bytes: Buffer.byteLength(kept, "utf8"),
    totalBytes,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function shorten(value: string, max = 60): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function count(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function firstTitle(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const items: unknown[] = value;
  const first = items[0];
  if (!isRecord(first)) return null;
  const title = first.title ?? first.name ?? first.id;
  return typeof title === "string" ? shorten(title) : null;
}

function bytes(text: string): string {
  const size = Buffer.byteLength(text, "utf8");
  return size < 1024 ? `${size} B` : `${Math.round(size / 1024)} KB`;
}

function workingSet(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const parts = Object.entries(value)
    .map(([key, entry]) => {
      const size = count(entry);
      return size === null || size === 0 ? null : `${size} ${key}`;
    })
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(", ") : "empty";
}

/** One line for the transcript, read off the response shape. */
export function summarize(text: string): string {
  const payload = parse(text);
  if (payload === null) return bytes(text);

  if (typeof payload.session_id === "string") {
    const set = workingSet(payload.working_set);
    return set === null ? `session ${payload.session_id}` : `session opened · ${set}`;
  }

  const results = count(payload.results);
  if (results !== null) {
    const total = typeof payload.total_matches === "number" ? payload.total_matches : results;
    const best = firstTitle(payload.results);
    const head = `${results} of ${total} hits`;
    return best === null ? head : `${head} · ${best}`;
  }

  for (const key of ["symbols", "nodes", "candidates", "sources", "jobs", "repos"]) {
    const size = count(payload[key]);
    if (size !== null) {
      const best = firstTitle(payload[key]);
      return best === null ? `${size} ${key}` : `${size} ${key} · ${best}`;
    }
  }

  if (typeof payload.id === "string") {
    const title = typeof payload.title === "string" ? ` · ${shorten(payload.title)}` : "";
    const revision = typeof payload.rev === "number" ? ` (rev ${payload.rev})` : "";
    return `${payload.id}${revision}${title}`;
  }

  const numbers = Object.entries(payload)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .slice(0, 3)
    .map(([key, value]) => `${key} ${value}`);
  return numbers.length > 0 ? numbers.join(", ") : bytes(text);
}

const CALL_ARGS = ["query", "name", "file", "title", "id", "ids", "repo", "path", "action"];

/** One line for the call row: the argument that says what the call is about. */
export function describeCall(args: Record<string, unknown>): string {
  for (const key of CALL_ARGS) {
    const value = args[key];
    if (typeof value === "string" && value !== "") return `${key}: ${shorten(value)}`;
    if (Array.isArray(value) && value.length > 0) return `${key}: ${shorten(value.join(", "))}`;
  }
  return "";
}

/** What the model reads at session start: the id it must quote, and the working set. */
export function greeting(text: string): string {
  return [
    "Cerebrium session opened by the pi extension. Use this `session_id` verbatim in every",
    "memory call; the bridge also fills it in when you omit it. Working set below — read it",
    "to orient before searching.",
    "",
    clip(text, 12_000, 200).text,
  ].join("\n");
}
