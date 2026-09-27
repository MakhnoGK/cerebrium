import { z } from "zod";

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export const sessionIdDescription =
  "Exact session_id returned by session_start. Copy it verbatim. Never invent, guess, transform, or reuse an id from another task. If unavailable, call session_start.";

export const nodeIdDescription =
  "Exact node id returned by session_start, search, get, write, update, or code_lookup. Copy it verbatim; never invent, guess, or transform it.";

export const sessionIdSchema = z
  .string()
  .regex(ULID_PATTERN, "session_id must be a valid ULID returned by session_start")
  .describe(sessionIdDescription);

export const nodeIdSchema = z
  .string()
  .regex(ULID_PATTERN, "node id must be a valid ULID returned by Cerebrium")
  .describe(nodeIdDescription);

export const nodeIdsSchema = z.array(nodeIdSchema);

export const candidateIdSchema = z
  .string()
  .regex(ULID_PATTERN, "candidate id must be a valid ULID returned by consolidate_suggest")
  .describe(
    "Exact consolidation candidate id returned by consolidate_suggest. Copy it verbatim; never invent, guess, or transform it.",
  );
