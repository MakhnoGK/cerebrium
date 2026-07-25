import { TypeOf, z, ZodObject } from "zod";
import type { Ctx } from "@/tools/context";
import { touchOrCreate } from "@/tools/context";
import { isDaemonAlive, readDaemonPid } from "@/runtime/daemon-pid";
import { AbstractTool, ToolName } from "@/tools/contracts";

export class StatsTool extends AbstractTool {
  name = ToolName.STATS;

  description =
    "Operational snapshot of the memory database — no node content, just counts and health. Returns: the embedding " +
    "queue (backlog awaiting vectors, parked items past max retries, oldest enqueued time, attempts histogram); content " +
    "totals (nodes by kind, edges, chunks embedded vs pending, sessions, events); storage (DB + WAL bytes, page stats); " +
    "and drain health (embedding provider, whether the background daemon is alive, and the current worker-lease holder); " +
    "and reranking (the configured reranker, whether it is enabled, and usage counters — how many searches were " +
    "rerank-eligible, how many actually reranked, and total candidates scored). " +
    "Use it to answer 'how many items are in the queue right now', 'is the embedding backlog being worked off', and " +
    "'is the reranker running'.";

  schema = {
    session_id: z
      .string()
      .optional()
      .describe("The id from session_start (auto-created if unknown). Omit for a read-only peek."),
  };

  protected async invoke(ctx: Ctx, args: TypeOf<ZodObject<typeof this.schema>>): Promise<unknown> {
    const hints = args.session_id ? touchOrCreate(ctx, args.session_id) : [];
    const stats = ctx.repo.techStats(ctx.now());

    if (args.session_id) {
      ctx.repo.logEvent("stats", args.session_id, null, null, ctx.now());
    }

    const { rerank_usage, ...rest } = stats;
    const out: Record<string, unknown> = {
      ...rest,
      drain: {
        ...stats.drain,
        provider: `${ctx.provider.name}@${ctx.provider.version}`,
        daemon_alive: isDaemonAlive(stats.storage.db_path),
        daemon_pid: readDaemonPid(stats.storage.db_path),
      },
      rerank: {
        provider: `${ctx.reranker.name}@${ctx.reranker.version}`,
        enabled: ctx.reranker.enabled,
        ...rerank_usage,
      },
    };

    if (hints.length) out.hints = hints;

    return out;
  }
}
