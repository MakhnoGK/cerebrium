import { z } from "zod";
import { MemoryKind } from "@/core/vocab";
import { ToolName } from "@/presentation/mcp/tools/contracts";

export const metadata = {
  name: ToolName.SEARCH,

  description:
    "Search memory. Returns compact envelopes only (never full content; call `get` with the ids you want). Default " +
    "mode blends full-text (bm25) and semantic vector similarity via Reciprocal Rank Fusion, then the memory model: " +
    "semantic facts rank steadily, episodic records decay with age, invalidated nodes are hidden unless `history:true`. " +
    "Each result carries `matched` ('text'|'vector'|'both'|'graph'); vector hits include a `best_chunk` snippet (often " +
    "enough to judge relevance without a `get`); graph-expanded neighbors carry `via:{node,edge}` showing why they " +
    "surfaced. The final cut is diversified (MMR, `MEMORY_MMR_LAMBDA`): among equally relevant hits it prefers " +
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
