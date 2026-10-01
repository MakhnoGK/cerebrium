import { injectable } from "tsyringe";
import type { ActivityEntry } from "@cerebrium/contracts/dashboard";
import type { EventAction } from "@cerebrium/contracts/vocab";
import type { SessionsRepo } from "@/domain/ports/storage";
import type { Writer } from "@/domain/writer";
import { activityOf, type EventRow } from "@/db/activity-rows";
import { BaseRepo } from "@/db/sqlite/base";
import { newId } from "@/core/ids";

// Sessions and the events audit log — provenance for every tool call.
@injectable()
export class SqliteSessionsRepo extends BaseRepo implements SessionsRepo {
  async create(
    id: string,
    project: string | null,
    ts: string,
    writer: Writer,
    principal_id: string,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO sessions (id, project, started_at, last_seen, client, client_version, principal_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`,
      )
      .run(id, project, ts, ts, writer.client, writer.version, principal_id);
  }

  // Who a session belongs to. Attribution goes through the session because that is where
  // the handshake recorded it; `ClientIdentity` holds the identity of the process, which is
  // not the same thing once one daemon serves several callers.
  async principalOf(id: string): Promise<string | null> {
    const row = this.db.prepare("SELECT principal_id FROM sessions WHERE id = ?").get(id) as
      { principal_id: string | null } | undefined;

    return row?.principal_id ?? null;
  }

  async touchExisting(id: string, ts: string): Promise<boolean> {
    return (
      this.db.prepare("UPDATE sessions SET last_seen = ? WHERE id = ?").run(ts, id).changes === 1
    );
  }

  async logEvent(
    action: EventAction,
    session_id: string,
    node_id: string | null,
    detail: unknown,
    ts: string,
  ): Promise<void> {
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

  async recentEvents(limit: number, before: string | null): Promise<ActivityEntry[]> {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.ts, e.action, e.session_id, e.node_id, e.detail,
                s.client, s.principal_id AS principal
         FROM events e LEFT JOIN sessions s ON s.id = e.session_id
         WHERE (@before IS NULL OR e.ts < @before)
         ORDER BY e.ts DESC, e.id DESC
         LIMIT @limit`,
      )
      .all({ before, limit }) as EventRow[];

    return Promise.resolve(rows.map(activityOf));
  }
}
