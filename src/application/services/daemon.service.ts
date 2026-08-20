import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { injectable } from "tsyringe";
import { DatabaseConfig } from "@/infrastructure/config";

@injectable()
export class DaemonService {
  constructor(private readonly database: DatabaseConfig) {}

  // "Is a drain daemon alive", self included. The spawn-dedup check in runtime/daemon-pid
  // deliberately excludes the caller's own pid; this one must not, because the daemon
  // answers `status` about itself and would otherwise report itself as not running.
  isDaemonAlive() {
    const pid = this.readDaemonPid();
    return pid != null && this.isProcessAlive(pid);
  }

  isProcessAlive(pid: number) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  readDaemonPid() {
    try {
      const pid = Number.parseInt(
        readFileSync(this.getDaemonPidPath(this.database.path), "utf8").trim(),
        10,
      );
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  getDaemonPidPath(dbPath: string) {
    const dir = dbPath === ":memory:" ? process.cwd() : dirname(dbPath);
    return join(dir, "daemon.pid");
  }
}
