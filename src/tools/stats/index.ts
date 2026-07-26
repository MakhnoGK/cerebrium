import { ToolArgs, touchOrCreate } from "@/tools/context";
import { isDaemonAlive, readDaemonPid } from "@/runtime/daemon-pid";
import { McpTool } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { metadata } from "@/tools/stats/metadata";

@tool()
export class StatsTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const hints = args.session_id ? touchOrCreate(this.ctx, args.session_id) : [];
    const stats = this.ctx.repo.techStats(this.ctx.now());

    if (args.session_id) {
      this.ctx.repo.logEvent("stats", args.session_id, null, null, this.ctx.now());
    }

    const { rerank_usage, ...rest } = stats;
    const out: Record<string, unknown> = {
      ...rest,
      drain: {
        ...stats.drain,
        provider: `${this.ctx.provider.name}@${this.ctx.provider.version}`,
        daemon_alive: isDaemonAlive(stats.storage.db_path),
        daemon_pid: readDaemonPid(stats.storage.db_path),
      },
      rerank: {
        provider: `${this.ctx.reranker.name}@${this.ctx.reranker.version}`,
        enabled: this.ctx.reranker.enabled,
        ...rerank_usage,
      },
    };

    if (hints.length) out.hints = hints;

    return out;
  }
}
