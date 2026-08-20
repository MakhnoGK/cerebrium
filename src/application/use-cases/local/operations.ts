import { inject } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { CONFIG_FILE_TOKEN, type ConfigFileReport } from "@/domain/ports/config";
import {
  EMBEDDING_PROVIDER_TOKEN,
  type EmbeddingProvider,
} from "@/domain/ports/embedding-provider";
import {
  CodeIndexService,
  DaemonService,
  EmbeddingService,
  ProcessRegistryService,
} from "@/application/services";
import {
  INDEX_CODE,
  OPERATOR_SNAPSHOT,
  STATS_SNAPSHOT,
  useCase,
  type IndexCode,
  type IndexCodeArgs,
  type IndexCodeResult,
  type OperatorSnapshot,
  type OperatorSnapshotResult,
  type StatsSnapshot,
} from "@/application/use-cases/contracts";
import { StatsRepo } from "@/db/repositories";
import { ConfigRegistry } from "@/infrastructure/config";

@useCase(INDEX_CODE)
export class LocalIndexCode implements IndexCode {
  constructor(
    private readonly embeddings: EmbeddingService,
    private readonly indexer: CodeIndexService,
  ) {}

  async invoke(args: IndexCodeArgs): Promise<IndexCodeResult> {
    const targets = this.indexer.resolveTargets({ repo: args.repo, path: args.path });
    const results = await this.indexer.indexTargets(targets, {
      session_id: args.session_id,
      force: args.force,
    });

    return { results, notes: this.embeddings.getEmbeddingNotes() };
  }
}

@useCase(STATS_SNAPSHOT)
export class LocalStatsSnapshot implements StatsSnapshot {
  constructor(
    private readonly daemon: DaemonService,
    private readonly statsRepo: StatsRepo,
    private readonly processes: ProcessRegistryService,
    private readonly config: ConfigRegistry,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
    @inject(EMBEDDING_PROVIDER_TOKEN) private readonly provider: EmbeddingProvider,
  ) {}

  invoke(): Promise<Record<string, unknown>> {
    const stats = this.statsRepo.techStats(this.clock.now());

    return Promise.resolve({
      ...stats,
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
        // Absent for a role that holds no model, so the key only appears where it means
        // something.
        ...(row.model_state ? { model_state: row.model_state } : {}),
      })),
      config: { ignored: this.config.ignored().map((entry) => entry.envName) },
    });
  }
}

@useCase(OPERATOR_SNAPSHOT)
export class LocalOperatorSnapshot implements OperatorSnapshot {
  constructor(
    private readonly daemon: DaemonService,
    private readonly statsRepo: StatsRepo,
    private readonly processes: ProcessRegistryService,
    private readonly config: ConfigRegistry,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
    @inject(EMBEDDING_PROVIDER_TOKEN) private readonly provider: EmbeddingProvider,
    @inject(CONFIG_FILE_TOKEN) private readonly file: ConfigFileReport | null,
  ) {}

  invoke(): Promise<OperatorSnapshotResult> {
    const stats = this.statsRepo.techStats(this.clock.now());
    const effective = this.config.effective();

    return Promise.resolve({
      ...stats,
      drain: {
        ...stats.drain,
        provider: `${this.provider.name}@${this.provider.version}`,
        daemon_alive: this.daemon.isDaemonAlive(),
        daemon_pid: this.daemon.readDaemonPid(),
      },
      processes: this.processes.list().map((row) => ({
        role: row.role,
        pid: row.pid,
        alive: row.alive,
        started_at: row.started_at,
        config_state: row.config_state,
        model_state: row.model_state,
        model_ms: row.model_ms,
        model_error: row.model_error,
      })),
      config: {
        file: this.file,
        values: effective.values,
        provenance: effective.provenance,
        ignored: this.config.ignored().map((entry) => entry.envName),
      },
    });
  }
}
