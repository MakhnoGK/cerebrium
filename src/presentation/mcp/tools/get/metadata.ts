import { z } from "zod";
import { ToolName } from "@/presentation/mcp/tools/contracts";

export const metadata = {
  name: ToolName.GET,

  description:
    "Fetch full node content by id: envelope + current markdown content + the node's incoming/outgoing edges " +
    "(neighbor stubs). This is the ONLY tool that returns full content — `search` and `session_start` return envelopes " +
    "only, so call `get` after deciding which ids are worth the tokens. Set `include_revisions` to see the edit history, " +
    "or pass `rev` (with a single id) to read a specific superseded revision. For a `symbol` (code mirror) node the result " +
    "also carries `source` (the raw source slice) and `symbol` (repo/path/lang/kind/signature/line span). For an external " +
    "mirror node it carries `url` (deep link), `facets` (structured metadata), and `mirror` (source_id/native_id). " +
    "Fetching a node also records the use: it earns a small bounded ranking boost, and for an episodic node it restarts " +
    "the decay clock, so what you actually come back to stays retrievable. Pass `as_of` to read the node as the store " +
    "held it at a past instant — the revision current then, and nothing at all if it did not yet exist or had already " +
    "been invalidated. That is the question to ask when auditing a decision taken on information that has since changed.",

  schema: {
    session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
    ids: z
      .array(z.string())
      .min(1)
      .describe("Node ids to fetch, from search/session_start envelopes."),
    include_revisions: z
      .boolean()
      .optional()
      .describe("Include the revision history (rev, ts, session, reason) — not old content."),
    rev: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Fetch a specific past revision's content; only valid when `ids` has exactly one element.",
      ),
    as_of: z
      .string()
      .optional()
      .describe(
        "ISO-8601 instant: read each node as the store held it then — the revision current at " +
          "that time; ids that did not exist yet, or were already invalidated, come back in " +
          "`not_found`. Cannot be combined with `rev`.",
      ),
  },
};
