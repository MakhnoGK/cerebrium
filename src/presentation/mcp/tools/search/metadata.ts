import { z } from "zod";
import { MemoryKind } from "@/core/vocab";
import { ToolName } from "@/presentation/mcp/tools/contracts";

export const metadata = {
  name: ToolName.SEARCH,

  description:
    "Search memory. Returns compact envelopes only (never full content; call `get` with the ids you want). Default " +
    "mode blends full-text (bm25) and semantic vector similarity via Reciprocal Rank Fusion, then the memory model: " +
    "semantic facts rank steadily, episodic records decay by disuse (the decay clock restarts whenever a node is " +
    "actually fetched with `get`, so a record you keep coming back to stays reachable), nodes fetched often carry a " +
    "small bounded importance boost, and invalidated nodes are hidden unless `history:true`. " +
    "Each result carries `matched` ('text'|'vector'|'both'|'graph'); vector hits include a `best_chunk` snippet (often " +
    "enough to judge relevance without a `get`) and, when the matched chunk sits under a heading, the `section` that " +
    "names it — pass that straight to `get`'s `sections` to read just that part of a long node instead of all of it. " +
    "Graph-expanded hits carry `via:{node,edge}` naming the hit that " +
    "contributed most to surfacing them. Graph expansion is personalized PageRank over the local subgraph seeded by " +
    "the matched nodes, so it reaches multi-hop associations and favours nodes that several matches agree on; a graph " +
    "hit never outranks the best direct one, and superseded nodes are unreachable this way. `as_of` re-runs the whole " +
    "thing against the store as it stood at a past instant, which is how you see what was knowable when a decision was " +
    "made. The final cut is diversified (MMR, `MEMORY_MMR_LAMBDA`): among equally relevant hits it prefers " +
    "ones that repeat each other less, so a fixed `limit` carries more distinct information. The top hit is always " +
    "the most relevant one, and `mode:'text'` is unaffected. Use `mode:'text'` for the cheapest exact Phase-1 behavior. When the " +
    "`MEMORY_RERANK` reranker is enabled, a local cross-encoder rescoring sharpens the " +
    "fused hits' precision before graph expansion — it is off by default, never applies " +
    "to graph neighbors, and never changes which fields a result returns. Code `symbol` mirrors are " +
    "down-weighted as direct hits so authored and external-mirror knowledge ranks first; ask for them " +
    "explicitly (`types:['symbol']` or `kinds:['mirror']`) to rank them normally. ALWAYS search before writing.",

  schema: {
    session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
    query: z
      .string()
      .describe(
        "Free text; treated as plain terms (quotes = phrase). FTS operators are neutralized.",
      ),
    project: z.string().optional().describe("Restrict to one project; omit to search across all."),
    kinds: z
      .array(z.nativeEnum(MemoryKind))
      .optional()
      .describe("Filter by memory_kind, e.g. ['semantic']."),
    types: z
      .array(z.string())
      .optional()
      .describe("Filter by node type, e.g. ['decision','fact']."),
    history: z
      .boolean()
      .optional()
      .describe(
        "Include invalidated/superseded nodes and drop episodic time-decay — for 'what did we try before'.",
      ),
    as_of: z
      .string()
      .optional()
      .describe(
        "ISO-8601 instant: search the store as it stood then — only nodes already written and " +
          "not yet invalidated at that time, graph expansion included. Supersedes `history`. " +
          "Note the text index holds current wording only, so this decides WHICH nodes are " +
          "considered, not how they were phrased then.",
      ),
    valid_at: z
      .string()
      .optional()
      .describe(
        "ISO-8601 instant on the EVENT axis: keep only nodes whose claimed validity window " +
          "contains it. A node that claims no window counts as always valid, so this narrows " +
          "rather than empties. Combine with `as_of` for the full question: what we believed " +
          "on one date about what was true on another.",
      ),
    mode: z
      .enum(["hybrid", "text", "vector"])
      .optional()
      .describe(
        "hybrid (default): fuse text + vector. 'text': FTS only (fastest). 'vector': semantic only.",
      ),
    expand_graph: z
      .boolean()
      .optional()
      .describe(
        "Also surface 1-hop neighbors of top hits (default true); each carries a `via` edge. Ignored in 'text' mode.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(25)
      .default(10)
      .describe("Max results (default 10, max 25)."),
  },
};
