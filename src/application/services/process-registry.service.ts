import { inject, injectable } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { CONFIG_FILE_TOKEN, type ConfigFileReport } from "@/domain/ports/config";
import { PROCESS_PROBE_TOKEN, type ProcessProbe } from "@/domain/ports/process-probe";
import { ProcessesRepo, type ProcessRow } from "@/db/repositories";
import { newId } from "@/core/ids";
import { ConfigRegistry, DatabaseConfig } from "@/infrastructure/config";

export interface LiveProcess extends ProcessRow {
  alive: boolean;
}

// Publishes what this process resolved, and reads back who else is up. This is what turns
// "am I sure the right configuration is loaded?" from unanswerable into a line of output.
@injectable()
export class ProcessRegistryService {
  constructor(
    private readonly processes: ProcessesRepo,
    private readonly config: ConfigRegistry,
    private readonly database: DatabaseConfig,
    @inject(CONFIG_FILE_TOKEN) private readonly configFile: ConfigFileReport | null,
    @inject(PROCESS_PROBE_TOKEN) private readonly probe: ProcessProbe,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  // Called once at host startup. Also sweeps rows whose process is gone, so a crashed
  // host (no chance to retire itself) cannot leave a permanent ghost in the registry.
  publish(role: string): string {
    const id = newId();

    this.processes.publish({
      id,
      role,
      pid: this.probe.self(),
      started_at: this.clock.now(),
      node_version: process.version,
      db_path: this.database.path,
      config_file: this.configFile?.path ?? null,
      config_state: this.configFile?.state ?? "pinned",
      config_json: JSON.stringify(this.config.effective().values),
    });

    this.sweepDead();

    return id;
  }

  retire(id: string): void {
    this.processes.retire([id]);
  }

  list(): LiveProcess[] {
    return this.processes.list().map((row) => ({ ...row, alive: this.isAlive(row) }));
  }

  private sweepDead(): void {
    const dead = this.processes.list().filter((row) => !this.isAlive(row));

    this.processes.retire(dead.map((row) => row.id));
  }

  private isAlive(row: ProcessRow): boolean {
    return row.pid === this.probe.self() || this.probe.alive(row.pid);
  }
}
