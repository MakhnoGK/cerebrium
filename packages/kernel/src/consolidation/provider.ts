// Faithfulness is the whole game for durable memory: summarize only what the records
// state, invent nothing. Shared by every generating provider, so the contract is one text.
import { ConsolidationKind } from "@cerebrium/contracts/vocab";
import {
  ConsolidationRecommendation,
  LinkConfidence,
  LinkRelation,
  ReconcileAction,
  type AnnotateResult,
  type AnnotateTask,
  type ConsolidationResult,
  type ConsolidationTask,
  type ReconcileResult,
  type ReconcileTask,
  type RelateRecord,
  type RelateResult,
  type RelateTask,
  type ResolveLinkResult,
  type ResolveLinkTask,
} from "@/domain/ports/consolidation-provider";

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

// The JSON schema a structured-output backend (e.g., Ollama `format`) enforces so the
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

// Total characters of record content one cluster prompt may carry.
export const CLUSTER_CHARS = 12_000;

const TRUNCATED = "\n…[truncated]";

function shares(lengths: number[], total: number): number[] {
  const out = new Array<number>(lengths.length).fill(0);
  const shortestFirst = lengths.map((_, i) => i).sort((a, b) => lengths[a]! - lengths[b]!);
  let left = total;
  let remaining = lengths.length;

  for (const i of shortestFirst) {
    const take = Math.min(lengths[i]!, Math.floor(left / remaining));
    out[i] = take;
    left -= take;
    remaining--;
  }

  return out;
}

function clip(content: string, budget: number): string {
  return content.length <= budget ? content : content.slice(0, budget).trimEnd() + TRUNCATED;
}

// The user message for a task: the cluster's records, labeled, ordered, and clipped to
// the cluster budget.
export function taskPrompt(task: ConsolidationTask): string {
  const verb =
    task.kind === ConsolidationKind.MERGE
      ? "Merge these near-duplicate records"
      : "Consolidate these records";
  const scope = task.project ? ` (project: ${task.project})` : "";
  const budgets = shares(
    task.inputs.map((r) => r.content.length),
    CLUSTER_CHARS,
  );
  const records = task.inputs
    .map((r, i) => `[${i + 1}] ${r.title}\n${clip(r.content, budgets[i]!)}`)
    .join("\n\n");

  return `${verb}${scope}:\n\n${records}`;
}

// Parse + validate a backend's JSON reply into a ConsolidationResult. Throws an
// actionable error on anything malformed, so the caller degrades to suggest/skip.
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

// The reconciled judge's contract. Faithfulness again: the provider decides an ACTION,
// it never rewrites memory. Erring toward `noop` keeps the writing path safe — a false
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

// Parse + validate a reconciled reply. Unknown/absent action degrades to 'noop' and a
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

// The annotated contract. Attributes are for RECALL, not display: keywords/synonyms the
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

// Parse + validate an annotated reply. Non-string array members are dropped and a
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

export const RELATE_SYSTEM_PROMPT =
  "You judge how two records, A and B, in an AI agent's durable memory relate. Pick ONE " +
  "relation: 'references' — one record cites, depends on or builds on the other; " +
  "'relates_to' — same topic, system or piece of work, neither depends on the other; " +
  "'supersedes' — one record is a newer version of the same fact and makes the other " +
  "outdated; 'duplicate_of' — both state the same fact and keeping one loses nothing; " +
  "'none' — they only share vocabulary and are about different things; two records about " +
  "the same feature, component or project thread are at least relates_to. For a directed " +
  "relation set from to the record that cites, the newer one, or the duplicate to fold " +
  "away; for relates_to and none set from to 'a'. When unsure, pick relates_to; pick " +
  "supersedes or duplicate_of only when certain. " +
  "Return JSON: relation, from ('a'|'b'), reason (one sentence).";

export const RELATE_SCHEMA = {
  type: "object",
  properties: {
    relation: { type: "string", enum: Object.values(LinkRelation) },
    from: { type: "string", enum: ["a", "b"] },
    reason: { type: "string" },
  },
  required: ["relation", "from", "reason"],
} as const;

const RELATE_RECORD_CHARS = 3_000;

function relateRecord(label: string, r: RelateRecord): string {
  return `[${label}] ${r.type}, written ${r.created_at.slice(0, 10)}: ${r.title}\n${clip(r.content, RELATE_RECORD_CHARS)}`;
}

export function relatePrompt(task: RelateTask): string {
  const scope = task.project ? ` (project: ${task.project})` : "";

  return `Two records${scope}:\n\n${relateRecord("A", task.a)}\n\n${relateRecord("B", task.b)}`;
}

export function parseRelate(raw: string): RelateResult {
  let obj: unknown;

  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("relate provider returned invalid JSON");
  }

  const o = obj as Record<string, unknown>;
  const relation = Object.values(LinkRelation).find((r) => r === o.relation);

  if (relation === undefined) {
    throw new Error(`relate provider returned an unknown relation: ${String(o.relation)}`);
  }

  return {
    relation,
    from: o.from === "b" ? "b" : "a",
    reason: typeof o.reason === "string" ? o.reason : "",
  };
}

export const RESOLVE_LINK_SYSTEM_PROMPT =
  "A note in an AI agent's durable memory links another note as [[link]], but no note " +
  "carries that name any more: the target was retitled, merged or never written. Given " +
  "the link, the text around it and the CANDIDATE notes, pick the one candidate the link " +
  "meant and return its id as target, or 'none' when no candidate is what the link names. " +
  "Judge by what the link and its surrounding sentence refer to, not by shared vocabulary " +
  "alone. confidence is 'high' only when the choice is clear from the texts — for a " +
  "candidate, that it is the very note the link names; for 'none', that every candidate " +
  "is about something else. Otherwise 'low'. " +
  "Return JSON: target (a candidate id or 'none'), confidence ('high'|'low'), reason " +
  "(one sentence).";

const NO_TARGET = "none";

export function resolveLinkSchema(task: ResolveLinkTask) {
  return {
    type: "object",
    properties: {
      target: { type: "string", enum: [...task.candidates.map((c) => c.id), NO_TARGET] },
      confidence: { type: "string", enum: Object.values(LinkConfidence) },
      reason: { type: "string" },
    },
    required: ["target", "confidence", "reason"],
  } as const;
}

const LINK_CANDIDATE_CHARS = 800;

export function resolveLinkPrompt(task: ResolveLinkTask): string {
  const scope = task.project ? ` (project: ${task.project})` : "";
  const candidates = task.candidates
    .map((c) => `[${c.id}] ${c.type}: ${c.title}\n${clip(c.content, LINK_CANDIDATE_CHARS)}`)
    .join("\n\n");

  return (
    `The note "${task.note.title}"${scope} links [[${task.link}]] here:\n` +
    `${task.note.context}\n\n` +
    `Candidates:\n\n${candidates}`
  );
}

export function parseResolveLink(raw: string, task: ResolveLinkTask): ResolveLinkResult {
  let obj: unknown;

  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("resolve-link provider returned invalid JSON");
  }

  const o = obj as Record<string, unknown>;
  const target = typeof o.target === "string" ? o.target : NO_TARGET;

  if (target !== NO_TARGET && !task.candidates.some((c) => c.id === target)) {
    throw new Error(`resolve-link provider named a target outside the candidates: ${target}`);
  }

  return {
    target_id: target === NO_TARGET ? null : target,
    confidence: o.confidence === LinkConfidence.HIGH ? LinkConfidence.HIGH : LinkConfidence.LOW,
    reason: typeof o.reason === "string" ? o.reason : "",
  };
}
