import { sessionIdSchema, ToolName } from "@/presentation/mcp/tools/contracts";

export const metadata = {
  name: ToolName.STATS,

  description:
    "Operational snapshot of the memory database — no node content, just counts and health. Returns: the embedding " +
    "queue (backlog awaiting vectors, parked items past max retries, oldest enqueued time, attempts histogram); content " +
    "totals (nodes by kind, edges, chunks embedded vs pending, the two vector pools — authored and code — counted " +
    "separately, sessions, events); storage (DB + WAL bytes, page stats); " +
    "drain health (embedding provider, whether the background daemon is alive, and the current worker-lease holder); " +
    "graph integrity (edges still pointing at soft-deleted nodes, how many of those are authored edges whose target has " +
    "a live successor, and live nodes stranded off the main graph — all three should read 0); " +
    "and generation (the configured backend, whether it generates at all, and what each role — generate, " +
    "reconcile, annotate — will actually be sent: model, host, deadline, and whether it inherits them). " +
    "Use it to answer 'how many items are in the queue right now', 'is the embedding backlog being worked off', " +
    "'has anything fallen out of the graph', and 'which model will judge my next write'.",

  schema: {
    session_id: sessionIdSchema.optional(),
  },
};
