// Faithfulness is the whole game for durable memory: summarize only what the records
// state, invent nothing. Shared by every generating provider so the contract is one text.
import {
  ConsolidationRecommendation,
  ReconcileAction,
  type AnnotateResult,
  type AnnotateTask,
  type ConsolidationResult,
  type ConsolidationTask,
  type ReconcileResult,
  type ReconcileTask,
} from "@/domain/ports/consolidation-provider";
import { ConsolidationKind } from "@/core/vocab";

export const SYSTEM_PROMPT =
  "You judge and consolidate a cluster of an AI agent's memory records. FIRST decide " +
  "whether they truly describe the SAME thing and should be consolidated into one note, " +
  "or are merely similar-looking but DISTINCT (e.g. two different services, features, or " +
  "entities that share vocabulary) and should be kept separate. Set recommendation to " +
  "'apply' only when they are genuinely the same and consolidating loses nothing; " +
  "otherwise 'reject'. Give a one-sentence reason. THEN draft the consolidated note " +
  "(used only if applied): summarize ONLY what the records state, invent nothing, add no " +
  "facts/dates/names/numbers absent from the inputs, and note (don't resolve) conflicts. " +
  "Return JSON: recommendation ('apply'|'reject'), reason (one sentence), title (short " +
  "noun phrase), summary (one sentence), body (2-4 sentences grounded in the records).";

// The JSON schema a structured-output backend (e.g. Ollama `format`) enforces so the
// response parses without fragility.
export const RESULT_SCHEMA = {
  type: "object",
  properties: {
    recommendation: { type: "string", enum: ["apply", "reject"] },
    reason: { type: "string" },
    title: { type: "string" },
    summary: { type: "string" },
    body: { type: "string" },
  },
  required: ["recommendation", "reason", "title", "summary", "body"],
} as const;

// The user message for a task: the cluster's records, labeled and ordered.
export function taskPrompt(task: ConsolidationTask): string {
  const verb =
    task.kind === ConsolidationKind.MERGE
      ? "Merge these near-duplicate records"
      : "Consolidate these records";
  const scope = task.project ? ` (project: ${task.project})` : "";
  const records = task.inputs.map((r, i) => `[${i + 1}] ${r.title}\n${r.content}`).join("\n\n");

  return `${verb}${scope}:\n\n${records}`;
}

// Parse + validate a backend's JSON reply into a ConsolidationResult. Throws an
// actionable error on anything malformed so the caller degrades to suggest/skip.
export function parseResult(raw: string): ConsolidationResult {
  let obj: unknown;

  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("consolidation provider returned invalid JSON");
  }

  const o = obj as Record<string, unknown>;

  if (typeof o.title !== "string" || typeof o.summary !== "string" || typeof o.body !== "string") {
    throw new Error("consolidation provider response missing title/summary/body strings");
  }

  const recommendation =
    o.recommendation === ConsolidationRecommendation.REJECT
      ? ConsolidationRecommendation.REJECT
      : ConsolidationRecommendation.APPLY;
  const reason = typeof o.reason === "string" ? o.reason : "";

  return { recommendation, reason, title: o.title, summary: o.summary, body: o.body };
}

// The reconcile judge's contract. Faithfulness again: the provider decides an ACTION,
// it never rewrites memory. Erring toward `noop` keeps the write path safe — a false
// `update`/`supersede` would push an agent to mangle an unrelated record.
export const RECONCILE_SYSTEM_PROMPT =
  "You are the write-time duplicate judge for an AI agent's durable memory. Given a NEW " +
  "record about to be written and the EXISTING records it resembles, decide ONE action: " +
  "'noop' — the new record is genuinely distinct, or adds nothing already covered, so keep " +
  "things as they are; 'update' — it refines or extends exactly ONE existing record, so the " +
  "agent should revise that node instead of creating a near-duplicate; 'supersede' — it " +
  "replaces or contradicts an existing record, which should be invalidated. Pick the single " +
  "existing record the action targets and return its id as target_id (null for noop). When " +
  "unsure, choose 'noop'. Judge only; never rewrite the records. Return JSON: action " +
  "('noop'|'update'|'supersede'), target_id (string|null), reason (one sentence).";

export const RECONCILE_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["noop", "update", "supersede"] },
    target_id: { type: ["string", "null"] },
    reason: { type: "string" },
  },
  required: ["action", "target_id", "reason"],
} as const;

// The user message for a reconcile task: the draft, then the resembling records labeled
// by id so the judge can name a target_id verbatim.
export function reconcilePrompt(task: ReconcileTask): string {
  const scope = task.project ? ` (project: ${task.project})` : "";
  const candidates = task.candidates.map((c) => `[${c.id}] ${c.title}\n${c.content}`).join("\n\n");

  return (
    `A new ${task.draft.type} record is about to be written${scope}:\n` +
    `${task.draft.title}\n${task.draft.content}\n\n` +
    `Existing records it resembles:\n\n${candidates}`
  );
}

// Parse + validate a reconcile reply. Unknown/absent action degrades to 'noop' and a
// non-string target_id to null, so a sloppy model can only ever be conservative.
export function parseReconcile(raw: string): ReconcileResult {
  let obj: unknown;

  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("reconcile provider returned invalid JSON");
  }

  const o = obj as Record<string, unknown>;
  const action =
    o.action === ReconcileAction.UPDATE || o.action === ReconcileAction.SUPERSEDE
      ? o.action
      : ReconcileAction.NOOP;
  const target_id = typeof o.target_id === "string" ? o.target_id : null;
  const reason = typeof o.reason === "string" ? o.reason : "";

  return { action, target_id, reason };
}

// The annotate contract. Attributes are for RECALL, not display: keywords/synonyms the
// author didn't necessarily write, a few topical tags, one sentence of context. Grounded
// in the record — no invented facts, dates, names, or numbers.
export const ANNOTATE_SYSTEM_PROMPT =
  "You enrich one of an AI agent's durable memory records for future retrieval. Read its " +
  "title and body, then propose search attributes: keywords — salient terms AND close " +
  "synonyms or alternate phrasings a future query might use to find this record, even if " +
  "not written verbatim; tags — a few short topical labels; context — one sentence saying " +
  "what this record is about. Ground everything in the record: surface what it is about, " +
  "invent no facts, dates, names, or numbers absent from it. Return JSON: keywords " +
  "(string[]), tags (string[]), context (string).";

export const ANNOTATE_SCHEMA = {
  type: "object",
  properties: {
    keywords: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    context: { type: "string" },
  },
  required: ["keywords", "tags", "context"],
} as const;

export function annotatePrompt(task: AnnotateTask): string {
  const scope = task.project ? ` (project: ${task.project})` : "";

  return `Record${scope}:\n${task.title}\n${task.content}`;
}

// Parse + validate an annotate reply. Non-string array members are dropped and a
// non-string context becomes empty, so a sloppy model degrades to fewer attributes
// rather than corrupting the FTS text.
export function parseAnnotate(raw: string): AnnotateResult {
  let obj: unknown;

  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("annotate provider returned invalid JSON");
  }

  const o = obj as Record<string, unknown>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  return {
    keywords: strings(o.keywords),
    tags: strings(o.tags),
    context: typeof o.context === "string" ? o.context : "",
  };
}

// The searchable text an annotation contributes to a node's FTS content. Kept out of the
// node's revision body (which stays exactly as authored) — this is appended only to the
// FTS index, so it widens matching without polluting what `get` returns.
export function annotationFtsText(a: AnnotateResult): string {
  return [...a.keywords, ...a.tags, a.context].filter(Boolean).join(" ").trim();
}
