import { injectable } from "tsyringe";
import type { EventAction } from "@cerebrium/contracts/vocab";
import type { SessionsRepo } from "@/domain/ports/storage";
import type { Writer } from "@/domain/writer";
import { PgBaseRepo } from "@/db/postgres/base";
import { newId } from "@/core/ids";

@injectable()
export class PgSessionsRepo extends PgBaseRepo implements SessionsRepo {
  async create(
    id: string,
    project: string | null,
    ts: string,
    writer: Writer,
    principal_id: string,
  ): Promise<void> {
    await this.run(
      `INSERT INTO sessions (id, project, started_at, last_seen, client, client_version, principal_id)
       VALUES (@id, @project, @ts, @ts, @client, @version, @principal_id)
       ON CONFLICT (id) DO UPDATE SET last_seen = excluded.last_seen`,
      { id, project, ts, client: writer.client, version: writer.version, principal_id },
    );
  }

  async principalOf(id: string): Promise<string | null> {
    return (
      (
        await this.one<{ principal_id: string | null }>(
          "SELECT principal_id FROM sessions WHERE id = @id",
          { id },
        )
      )?.principal_id ?? null
    );
  }

  async touchExisting(id: string, ts: string): Promise<boolean> {
    return (await this.run("UPDATE sessions SET last_seen = @ts WHERE id = @id", { ts, id })) === 1;
  }

  async logEvent(
    action: EventAction,
    session_id: string,
    node_id: string | null,
    detail: unknown,
    ts: string,
  ): Promise<void> {
    await this.run(
      `INSERT INTO events (id, session_id, action, node_id, detail, ts)
       VALUES (@id, @session_id, @action, @node_id, @detail, @ts)`,
      {
        id: newId(),
        session_id,
        action,
        node_id,
        detail: detail == null ? null : JSON.stringify(detail),
        ts,
      },
    );
  }
}
