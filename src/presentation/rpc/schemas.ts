import { z } from "zod";
import { CALL_SURFACE, NotificationTopic, type CallName } from "@/application/use-cases";
import { EdgeType, MemoryKind, ReviewArtifact, ReviewDecision } from "@/core/vocab";

// Argument validation for the socket edge. The MCP layer validates its own edge with zod
// schemas; this is the same guarantee for the other one, rather than the use cases being
// handed raw JSON. Without it a malformed call reached the writer and surfaced as an
// internal TypeError instead of invalid-params.
//
// These describe the *use-case* arguments, not the MCP tool arguments. The two are close
// but not identical — a tool maps and defaults before calling — so reusing the tool schemas
// here would reject valid calls and accept invalid ones.
//
// Unknown keys pass: a newer client sending a field this build does not know is not an
// error, and rejecting it would make the protocol version harder to move, not safer.

const ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "must be a ULID");
const session = z.object({ session_id: ulid });
const iso = z.string().datetime({ offset: true });
const eventWindow = { event_from: iso.optional(), event_to: iso.optional() };
const page = { page_size: z.number().int().optional(), cursor: z.string().optional() };

const SCHEMAS = {
  // Reads
  search_memory: z.object({
    session_id: ulid.optional(),
    query: z.string().min(1),
    limit: z.number().int().positive().optional(),
    project: z.string().optional(),
    kinds: z.array(z.nativeEnum(MemoryKind)).optional(),
    types: z.array(z.string()).optional(),
    history: z.boolean().optional(),
    mode: z.enum(["hybrid", "text", "vector"]).optional(),
    expand_graph: z.boolean().optional(),
    as_of: iso.optional(),
    valid_at: iso.optional(),
    query_vector: z.array(z.number()).optional(),
  }),
  fetch_nodes: z.object({
    session_id: ulid.optional(),
    ids: z.array(ulid).min(1),
    rev: z.number().int().positive().optional(),
    as_of: iso.optional(),
    sections: z.array(z.string()).optional(),
    outline: z.boolean().optional(),
    include_revisions: z.boolean().optional(),
  }),
  lookup_code: z.object({
    session_id: ulid.optional(),
    name: z.string().optional(),
    file: z.string().optional(),
    repo: z.string().optional(),
    limit: z.number().int().positive().optional(),
  }),
  stats_snapshot: z.object({ session_id: ulid.optional() }),
  operator_snapshot: z.object({ session_id: ulid.optional() }),
  suggest_candidates: z.object({
    session_id: ulid.optional(),
    kind: z.string().optional(),
    limit: z.number().int().positive().optional(),
    ...page,
  }),
  mirror_status: z.object({ session_id: ulid.optional(), source_id: z.string().optional() }),
  job_status: z.object({
    session_id: ulid.optional(),
    id: ulid.optional(),
    kind: z.string().optional(),
    limit: z.number().int().positive().optional(),
  }),

  // Writes
  //
  // No `client` here, deliberately: the writer identity arrives in the request's `meta`,
  // stamped by the host from its MCP handshake. A caller-supplied one is stripped by this
  // schema before the pipeline sees it.
  start_session: z.object({ project: z.string().nullable().optional() }),
  session_hints: session,
  subscribe_events: session.extend({
    topics: z.array(z.nativeEnum(NotificationTopic)),
  }),
  write_memory: session.extend({
    memory_kind: z.nativeEnum(MemoryKind),
    type: z.string().min(1),
    title: z.string().min(1),
    content: z.string().min(1),
    project: z.string().nullable(),
    parent_node_id: ulid.nullable(),
    links: z.array(z.object({ dst: ulid, type: z.nativeEnum(EdgeType) })).optional(),
    ...eventWindow,
  }),
  update_memory: session.extend({
    id: ulid,
    content: z.string().optional(),
    title: z.string().optional(),
    reason: z.string().optional(),
    ...eventWindow,
  }),
  invalidate_memory: session.extend({ id: ulid, superseded_by: ulid.optional() }),
  restore_memory: session.extend({ id: ulid }),
  list_reviews: z.object({
    session_id: ulid.optional(),
    artifact: z.nativeEnum(ReviewArtifact).optional(),
    limit: z.number().int().positive().optional(),
  }),
  resolve_review: session.extend({
    artifact: z.nativeEnum(ReviewArtifact),
    ref: z.string().min(1),
    decision: z.nativeEnum(ReviewDecision),
    note: z.string().optional(),
  }),
  link_nodes: session.extend({
    src: ulid,
    dst: ulid,
    type: z.nativeEnum(EdgeType),
    weight: z.number().min(0).max(1).optional(),
  }),
  record_checkpoint: session.extend({
    title: z.string().min(1),
    summary: z.string().min(1),
    decisions: z.array(z.string()).optional(),
    open_threads: z.array(z.string()).optional(),
    project: z.string().optional(),
    touched_node_ids: z.array(ulid).optional(),
  }),
  register_source: z.object({
    session_id: ulid.optional(),
    id: z.string().min(1),
    kind: z.string().min(1),
    label: z.string().optional(),
    project: z.string().optional(),
    freshness_hours: z.number().optional(),
    recipe: z.string().optional(),
    enabled: z.boolean().optional(),
  }),
  upsert_mirrors: session.extend({
    source_id: z.string().min(1),
    items: z.array(z.record(z.unknown())).min(1),
  }),
  apply_candidate: session.extend({
    id: ulid,
    decision: z.string().min(1),
    override: z.record(z.unknown()).optional(),
    collapse: z.boolean().optional(),
  }),
  retry_candidate: session.extend({ id: ulid }),
  index_code: session.extend({
    repo: z.string().optional(),
    path: z.string().optional(),
    force: z.boolean().optional(),
  }),
  submit_job: session.extend({
    kind: z.string().min(1),
    payload: z.record(z.unknown()).optional(),
    scheduled_for: iso.optional(),
  }),
} as const satisfies Record<CallName, z.ZodType>;

export class InvalidArgsError extends Error {
  constructor(
    readonly call: CallName,
    readonly issues: string[],
  ) {
    super(`invalid arguments for ${call}: ${issues.join("; ")}`);
    this.name = "InvalidArgsError";
  }
}

// Every call on the surface has a schema. A new call added without one would otherwise
// reach the writer unvalidated, so the gap is a type error rather than a runtime surprise.
export function validateCall(name: CallName, args: unknown): Record<string, unknown> {
  const parsed = SCHEMAS[name].safeParse(args ?? {});

  if (!parsed.success) {
    throw new InvalidArgsError(
      name,
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }

  return parsed.data;
}

export const CALL_SCHEMAS: Readonly<Record<CallName, z.ZodType>> = SCHEMAS;

// Kept so a test can prove the two lists cannot drift apart.
export function schemaNames(): CallName[] {
  return Object.keys(SCHEMAS) as CallName[];
}

export function surfaceNames(): CallName[] {
  return Object.keys(CALL_SURFACE) as CallName[];
}
