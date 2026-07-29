import { z } from "zod";
import { ToolName } from "@/presentation/mcp/tools/contracts";

export const metadata = {
  name: ToolName.STATS,

  description:
    "Operational snapshot of the memory database — no node content, just counts and health. Returns: the embedding " +
    "queue (backlog awaiting vectors, parked items past max retries, oldest enqueued time, attempts histogram); content " +
    "totals (nodes by kind, edges, chunks embedded vs pending, sessions, events); storage (DB + WAL bytes, page stats); " +
    "and drain health (embedding provider, whether the background daemon is alive, and the current worker-lease holder); " +
    "and reranking (the configured reranker, whether it is enabled, and usage counters — how many searches were " +
    "rerank-eligible, how many actually reranked, and total candidates scored). " +
    "Use it to answer 'how many items are in the queue right now', 'is the embedding backlog being worked off', and " +
    "'is the reranker running'.",

  schema: {
    session_id: z
      .string()
      .optional()
      .describe("The id from session_start (auto-created if unknown). Omit for a read-only peek."),
  },
};
