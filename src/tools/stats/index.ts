import { inject } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import {
  EMBEDDING_PROVIDER_TOKEN,
  type EmbeddingProvider,
} from "@/domain/ports/embedding-provider";
import { RERANK_PROVIDER_TOKEN, type RerankProvider } from "@/domain/ports/rerank-provider";
import { StatsRepo } from "@/db/repositories";
import { ToolArgs } from "@/tools/context";
import { McpTool } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { DaemonService } from "@/tools/services/daemon.service";
import { HintsService } from "@/tools/services/hints.service";
import { metadata } from "@/tools/stats/metadata";

@tool()
export class StatsTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    private readonly daemon: DaemonService,
    private readonly statsRepo: StatsRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
    @inject(EMBEDDING_PROVIDER_TOKEN) private readonly provider: EmbeddingProvider,
    @inject(RERANK_PROVIDER_TOKEN) private readonly reranker: RerankProvider,
  ) {}

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const stats = this.statsRepo.techStats(this.clock.now());
    const hints = args.session_id
      ? await this.hints.getUnknownSessionHints(args.session_id, null)
      : [];

    const { rerank_usage, ...rest } = stats;

    return {
      ...rest,
      drain: {
        ...stats.drain,
        provider: `${this.provider.name}@${this.provider.version}`,
        daemon_alive: this.daemon.isDaemonAlive(),
        daemon_pid: this.daemon.readDaemonPid(),
      },
      rerank: {
        provider: `${this.reranker.name}@${this.reranker.version}`,
        enabled: this.reranker.enabled,
        ...rerank_usage,
      },
      ...(hints.length ? { hints } : {}),
    };
  }
}
