import { z } from "zod";
import type { Ctx, ToolArgs } from "@/tools/context";
import { touchOrCreate } from "@/tools/context";

export const schema = {
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
};

export const description =
  "Fetch full node content by id: envelope + current markdown content + the node's incoming/outgoing edges " +
  "(neighbor stubs). This is the ONLY tool that returns full content — `search` and `session_start` return envelopes " +
  "only, so call `get` after deciding which ids are worth the tokens. Set `include_revisions` to see the edit history, " +
  "or pass `rev` (with a single id) to read a specific superseded revision. For a `symbol` (code mirror) node the result " +
  "also carries `source` (the raw source slice) and `symbol` (repo/path/lang/kind/signature/line span). For an external " +
  "mirror node it carries `url` (deep link), `facets` (structured metadata), and `mirror` (source_id/native_id).";

export async function handler(ctx: Ctx, args: ToolArgs<typeof schema>) {
  const hints = touchOrCreate(ctx, args.session_id);

  if (args.rev !== undefined && args.ids.length !== 1) {
    throw new Error("`rev` can only be used when `ids` has exactly one element.");
  }

  const nodes: unknown[] = [];
  const notFound: string[] = [];

  for (const id of args.ids) {
    const full = ctx.repo.fullNode(id);
    if (!full) {
      notFound.push(id);
      continue;
    }
    const node: Record<string, unknown> = {
      ...full.envelope,
      content: full.content,
      edges: full.edges,
    };
    if (full.envelope.type === "symbol") {
      const detail = ctx.repo.symbolDetail(id);
      if (detail) {
        // For a code mirror, `get` is the sanctioned place to return the raw source
        // slice + structured facets (search/code_lookup return envelopes only).
        const { source, ...facets } = detail;
        node.symbol = facets;
        node.source = source;
      }
    } else if (full.envelope.kind === "mirror") {
      // For an external mirror, `get` also carries the source back-reference, the
      // deep-link URL, and the opaque facet metadata (search returns envelopes only).
      const rec = ctx.repo.mirrorRecord(id);
      if (rec) {
        node.mirror = { source_id: rec.source_id, native_id: rec.native_id };
        if (rec.url != null) node.url = rec.url;
        if (rec.facets != null) node.facets = rec.facets;
      }
    }
    if (args.rev !== undefined) {
      const old = ctx.repo.revisionContent(id, args.rev);
      if (old === undefined) throw new Error(`node ${id} has no revision ${args.rev}.`);
      node.content = old;
      node.shown_rev = args.rev;
    }
    if (args.include_revisions) node.revisions = ctx.repo.listRevisions(id);
    nodes.push(node);
  }

  ctx.repo.logEvent(
    "get",
    args.session_id,
    args.ids[0] ?? null,
    { count: args.ids.length },
    ctx.now(),
  );

  const out: Record<string, unknown> = { nodes };
  if (notFound.length) out.not_found = notFound;
  if (hints.length) out.hints = hints;
  return out;
}
