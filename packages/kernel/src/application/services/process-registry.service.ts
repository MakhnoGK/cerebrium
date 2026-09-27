import { inject, injectable } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { CONFIG_FILE_TOKEN, type ConfigFileReport } from "@/domain/ports/config";
import { PROCESS_PROBE_TOKEN, type ProcessProbe } from "@/domain/ports/process-probe";
import {
  PROCESSES_REPO_TOKEN,
  STORE_TOKEN,
  type ProcessesRepo,
  type ProcessRow,
  type Store,
} from "@/domain/ports/storage";
import type { WarmupOutcome } from "@/application/services/model-warmup.service";
import { newId } from "@/core/ids";
import { ConfigRegistry } from "@/infrastructure/config";

export interface LiveProcess extends ProcessRow {
  alive: boolean;
}

// Publishes what this process resolved, and reads back who else is up. This is what turns
// "am I sure the right configuration is loaded?" from unanswerable into a line of output.
@injectable()
export class ProcessRegistryService {
  constructor(
    @inject(PROCESSES_REPO_TOKEN) private readonly processes: ProcessesRepo,
    private readonly config: ConfigRegistry,
    @inject(STORE_TOKEN) private readonly store: Store,
    @inject(CONFIG_FILE_TOKEN) private readonly configFile: ConfigFileReport | null,
    @inject(PROCESS_PROBE_TOKEN) private readonly probe: ProcessProbe,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  // Called once at host startup. Also sweeps rows whose process is gone, so a crashed
  // host (no chance to retire itself) cannot leave a permanent ghost in the registry.
  async publish(role: string): Promise<string> {
    const id = newId();

    await this.processes.publish({
      id,
      role,
      host: this.probe.host(),
      pid: this.probe.self(),
      started_at: this.clock.now(),
      node_version: process.version,
      db_path: this.store.identity,
      config_file: this.configFile?.path ?? null,
      config_state: this.configFile?.state ?? "pinned",
      config_json: JSON.stringify(this.config.effective().values),
    });

    await this.sweepDead();

    return id;
  }

  async recordModel(id: string, outcome: WarmupOutcome): Promise<void> {
    await this.processes.recordModel(id, outcome.state, outcome.ms, outcome.error ?? null);
  }

  async retire(id: string): Promise<void> {
    await this.processes.retire([id]);
  }

  async list(): Promise<LiveProcess[]> {
    return (await this.processes.list()).map((row) => ({ ...row, alive: this.isAlive(row) }));
  }

  private async sweepDead(): Promise<void> {
    const dead = (await this.processes.list()).filter((row) => !this.isAlive(row));

    await this.processes.retire(dead.map((row) => row.id));
  }

  // Another host's pid cannot be probed from here, so its rows count as alive: only that
  // host's own processes can retire them.
  private isAlive(row: ProcessRow): boolean {
    if (row.host !== this.probe.host()) return true;

    return row.pid === this.probe.self() || this.probe.alive(row.pid);
  }
}
