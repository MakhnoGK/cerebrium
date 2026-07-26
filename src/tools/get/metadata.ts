import { z } from "zod";
import { ToolName } from "@/tools/contracts";

export const metadata = {
  name: ToolName.GET,

  description:
    "Fetch full node content by id: envelope + current markdown content + the node's incoming/outgoing edges " +
    "(neighbor stubs). This is the ONLY tool that returns full content — `search` and `session_start` return envelopes " +
    "only, so call `get` after deciding which ids are worth the tokens. Set `include_revisions` to see the edit history, " +
    "or pass `rev` (with a single id) to read a specific superseded revision. For a `symbol` (code mirror) node the result " +
    "also carries `source` (the raw source slice) and `symbol` (repo/path/lang/kind/signature/line span). For an external " +
    "mirror node it carries `url` (deep link), `facets` (structured metadata), and `mirror` (source_id/native_id).",

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
  },
};
