import { inject } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import {
  EMBEDDING_PROVIDER_TOKEN,
  type EmbeddingProvider,
} from "@/domain/ports/embedding-provider";
import { DaemonService, HintsService, ProcessRegistryService } from "@/application/services";
import { StatsRepo } from "@/db/repositories";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";
import { metadata } from "@/presentation/mcp/tools/stats/metadata";
import { ConfigRegistry } from "@/infrastructure/config";

@tool()
export class StatsTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    private readonly daemon: DaemonService,
    private readonly statsRepo: StatsRepo,
    private readonly processes: ProcessRegistryService,
    private readonly config: ConfigRegistry,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
    @inject(EMBEDDING_PROVIDER_TOKEN) private readonly provider: EmbeddingProvider,
  ) {}

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const stats = this.statsRepo.techStats(this.clock.now());
    const hints = args.session_id ? await this.hints.getSessionHints(args.session_id) : [];

    const { ...rest } = stats;

    return {
      ...rest,
      drain: {
        ...stats.drain,
        provider: `${this.provider.name}@${this.provider.version}`,
        daemon_alive: this.daemon.isDaemonAlive(),
        daemon_pid: this.daemon.readDaemonPid(),
      },
      // The registry and the ignored-config channel, compact: which processes are up and
      // whether any variable was set but unusable. Values themselves stay out — an agent
      // should not pay tokens for the whole config table (`cerebrium-stats` prints it).
      processes: this.processes.list().map((row) => ({
        role: row.role,
        pid: row.pid,
        alive: row.alive,
        started_at: row.started_at,
        config_state: row.config_state,
      })),
      config: { ignored: this.config.ignored().map((entry) => entry.envName) },
      ...(hints.length ? { hints } : {}),
    };
  }
}
