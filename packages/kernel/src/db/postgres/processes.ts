import { injectable } from "tsyringe";
import type { ProcessesRepo, ProcessRow } from "@/domain/ports/storage";
import { PgBaseRepo } from "@/db/postgres/base";

@injectable()
export class PgProcessesRepo extends PgBaseRepo implements ProcessesRepo {
  async publish(row: Omit<ProcessRow, "model_state" | "model_ms" | "model_error">): Promise<void> {
    await this.tx(async () => {
      await this.db.query("DELETE FROM processes WHERE host = @host AND pid = @pid", {
        host: row.host,
        pid: row.pid,
      });
      await this.db.query(
        `INSERT INTO processes
           (id, role, host, pid, started_at, node_version, db_path, config_file, config_state, config_json)
         VALUES (@id, @role, @host, @pid, @started_at, @node_version, @db_path, @config_file, @config_state, @config_json)`,
        { ...row },
      );
    });
  }

  async list(): Promise<ProcessRow[]> {
    return this.all<ProcessRow>("SELECT * FROM processes ORDER BY started_at, id");
  }

  async recordModel(id: string, state: string, ms: number, error: string | null): Promise<void> {
    await this.run(
      "UPDATE processes SET model_state = @state, model_ms = @ms, model_error = @error WHERE id = @id",
      { state, ms, error, id },
    );
  }

  async retire(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    await this.run("DELETE FROM processes WHERE id = ANY(@ids)", { ids });
  }
}
