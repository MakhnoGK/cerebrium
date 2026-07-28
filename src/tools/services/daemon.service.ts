import { injectable } from "tsyringe";
import { readFileSync } from "node:fs";
import { defaultDbPath } from "@/db/database";
import { dirname, join } from "node:path";

@injectable()
export class DaemonService {
  isDaemonAlive() {
    const pid = this.readDaemonPid();
    return pid != null && pid !== process.pid && this.isProcessAlive(pid);
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
        readFileSync(this.getDaemonPidPath(defaultDbPath()), "utf8").trim(),
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
