import { ToolArgs } from "@/tools/context";
import { McpTool } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { metadata } from "@/tools/stats/metadata";
import { StatsRepo } from "@/db/repositories";
import { HintsService } from "../services/hints.service";
import { DaemonService } from "../services/daemon.service";

@tool()
export class StatsTool implements McpTool<(typeof metadata)["schema"], unknown> {
  constructor(
    private readonly hintsService: HintsService,
    private readonly daemonService: DaemonService,
    private readonly statsRepo: StatsRepo,
  ) {}

  public getMetadata = () => metadata;

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const now = new Date().toISOString();

    const stats = this.statsRepo.techStats(now);
    const hints = args.session_id
      ? await this.hintsService.getUnknownSessionHints(args.session_id, null)
      : [];

    if (args.session_id) {
      // this.ctx.repo.logEvent("stats", args.session_id, null, null, this.ctx.now());
    }

    const { rerank_usage, ...rest } = stats;

    return {
      ...rest,
      drain: {
        ...stats.drain,
        provider: `${this.ctx.provider.name}@${this.ctx.provider.version}`,
        daemon_alive: this.daemonService.isDaemonAlive(),
        daemon_pid: this.daemonService.readDaemonPid(),
      },
      rerank: {
        provider: `${this.ctx.reranker.name}@${this.ctx.reranker.version}`,
        enabled: this.ctx.reranker.enabled,
        ...rerank_usage,
      },
      ...(hints.length ? { hints } : {}),
    };
  }
}
