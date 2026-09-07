import { injectable } from "tsyringe";
import { BaseRepo } from "@/db/repositories/base";
import type { Writer } from "@/runtime/client-identity";
import { newId } from "@/core/ids";
import type { EventAction } from "@/core/vocab";

// Sessions and the events audit log — provenance for every tool call.
@injectable()
export class SessionsRepo extends BaseRepo {
  create(
    id: string,
    project: string | null,
    ts: string,
    writer: Writer,
    principal_id: string,
  ): void {
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
  principalOf(id: string): string | null {
    const row = this.db.prepare("SELECT principal_id FROM sessions WHERE id = ?").get(id) as
      { principal_id: string | null } | undefined;

    return row?.principal_id ?? null;
  }

  touchExisting(id: string, ts: string): boolean {
    return (
      this.db.prepare("UPDATE sessions SET last_seen = ? WHERE id = ?").run(ts, id).changes === 1
    );
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
