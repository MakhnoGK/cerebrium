import { injectable } from "tsyringe";
import { BaseRepo } from "@/db/repositories/base";

export interface ProcessRow {
  id: string;
  role: string;
  pid: number;
  started_at: string;
  node_version: string;
  db_path: string;
  config_file: string | null;
  config_state: string;
  config_json: string;
}

// The process registry: which Cerebrium processes are up, and what each one resolved its
// configuration to. Liveness is not stored — a pid outlives the process that owned it, so
// callers probe instead (see ProcessRegistryService).
@injectable()
export class ProcessesRepo extends BaseRepo {
  // A pid is unique but reusable, so publishing claims it: any row left by whatever held
  // this pid before is replaced rather than accumulating beside the live one.
  publish(row: ProcessRow): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM processes WHERE pid = ?").run(row.pid);
      this.db
        .prepare(
          `INSERT INTO processes
             (id, role, pid, started_at, node_version, db_path, config_file, config_state, config_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.role,
          row.pid,
          row.started_at,
          row.node_version,
          row.db_path,
          row.config_file,
          row.config_state,
          row.config_json,
        );
    });
  }

  list(): ProcessRow[] {
    return this.db
      .prepare("SELECT * FROM processes ORDER BY started_at")
      .all() as unknown as ProcessRow[];
  }

  retire(ids: string[]): void {
    if (ids.length === 0) return;

    const placeholders = ids.map(() => "?").join(", ");

    this.tx(() => {
      this.db.prepare(`DELETE FROM processes WHERE id IN (${placeholders})`).run(...ids);
    });
  }
}
