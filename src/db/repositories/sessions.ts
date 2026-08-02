import { injectable } from "tsyringe";
import { BaseRepo } from "@/db/repositories/base";
import { newId } from "@/core/ids";
import type { EventAction } from "@/core/vocab";

// Sessions and the events audit log — provenance for every tool call.
@injectable()
export class SessionsRepo extends BaseRepo {
  // Register a session id, or refresh an existing one. Every tool advertises session_id as
  // "auto-created if unknown" and the server serves queued requests concurrently, so this
  // must not be a read-then-write: the conflict clause makes the insert unconditional and
  // its `changes` count is the exact answer to "did this call create it".
  touch(id: string, project: string | null, ts: string): { created: boolean } {
    const inserted = this.db
      .prepare(
        `INSERT INTO sessions (id, project, started_at, last_seen) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(id, project, ts, ts);

    if (inserted.changes === 1) {
      return { created: true };
    }

    this.db.prepare("UPDATE sessions SET last_seen = ? WHERE id = ?").run(ts, id);

    return { created: false };
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
