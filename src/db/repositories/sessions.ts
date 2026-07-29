import { injectable } from "tsyringe";
import { BaseRepo } from "@/db/repositories/base";
import { newId } from "@/core/ids";
import type { EventAction } from "@/core/vocab";

// Sessions and the events audit log — provenance for every tool call.
@injectable()
export class SessionsRepo extends BaseRepo {
  /** @deprecated */
  ensureSession(id: string, project: string | null, ts: string): { created: boolean } {
    const row = this.db.prepare("SELECT id FROM sessions WHERE id = ?").get(id);

    if (row) {
      this.db.prepare("UPDATE sessions SET last_seen = ? WHERE id = ?").run(ts, id);
      return { created: false };
    }

    this.db
      .prepare("INSERT INTO sessions (id, project, started_at, last_seen) VALUES (?, ?, ?, ?)")
      .run(id, project, ts, ts);

    return { created: true };
  }

  async getById(id: string) {
    return this.db.prepare("SELECT id FROM sessions WHERE id = ?").get(id);
  }

  async update(
    data: Record<string, number | string | boolean>,
    filter: Record<string, number | string | boolean>,
  ) {
    const set = Object.keys(data)
      .map((key) => `${key} = ?`)
      .join(", ");

    const where = Object.keys(filter)
      .map((key) => `${key} = ?`)
      .join(" AND ");

    this.db
      .prepare(`UPDATE sessions SET ${set} WHERE ${where}`)
      .run(...Object.values(data), ...Object.values(filter));
  }

  async create(data: Record<string, unknown>) {
    const fields = Object.keys(data);
    const columns = fields.join(", ");

    const params = fields.map((field) => `@${field}`).join(", ");
    const sql = `INSERT INTO sessions (${columns}) VALUES (${params})`;

    this.db.prepare(sql).run(data);
  }

  logEvent(
    action: EventAction,
    session_id: string,
    node_id: string | null,
    detail: unknown,
    ts: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO events (id, session_id, action, node_id, detail, ts) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        newId(),
        session_id,
        action,
        node_id,
        detail == null ? null : JSON.stringify(detail),
        ts,
      );
  }
}
