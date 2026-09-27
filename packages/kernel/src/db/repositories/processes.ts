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
  // Set only by a host that pre-warms an embedding model; null for roles that hold none.
  model_state: string | null;
  model_ms: number | null;
  model_error: string | null;
}

// The process registry: which Cerebrium processes are up, and what each one resolved its
// configuration to. Liveness is not stored — a pid outlives the process that owned it, so
// callers probe instead (see ProcessRegistryService).
@injectable()
export class ProcessesRepo extends BaseRepo {
  // A pid is unique but reusable, so publishing claims it: any row left by whatever held
  // this pid before is replaced rather than accumulating beside the live one.
  publish(row: Omit<ProcessRow, "model_state" | "model_ms" | "model_error">): void {
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

  // A read-only handle never runs migrations, so the inspection CLI can reach a store
  // whose writer has not started since this table was added. An empty registry is the
  // honest answer there; failing would break a command documented as safe to run anytime.
  list(): ProcessRow[] {
    if (!this.exists()) return [];

    return this.db
      .prepare("SELECT * FROM processes ORDER BY started_at")
      .all() as unknown as ProcessRow[];
  }

  private exists(): boolean {
    return (
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'processes'")
        .get() !== undefined
    );
  }

  // Separate from `publish` because warming finishes after the row exists: a reader in
  // between sees the process as up with no model loaded yet, which is the truth.
  recordModel(id: string, state: string, ms: number, error: string | null): void {
    this.tx(() => {
      this.db
        .prepare("UPDATE processes SET model_state = ?, model_ms = ?, model_error = ? WHERE id = ?")
        .run(state, ms, error, id);
    });
  }

  retire(ids: string[]): void {
    if (ids.length === 0) return;

    const placeholders = ids.map(() => "?").join(", ");

    this.tx(() => {
      this.db.prepare(`DELETE FROM processes WHERE id IN (${placeholders})`).run(...ids);
    });
  }
}
