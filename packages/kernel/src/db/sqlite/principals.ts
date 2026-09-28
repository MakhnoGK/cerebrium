import { injectable } from "tsyringe";
import { PrincipalKind, UNATTRIBUTED_PRINCIPAL } from "@cerebrium/contracts/vocab";
import type { PrincipalRow, PrincipalsRepo } from "@/domain/ports/storage";
import { principalOfWriter, type Writer } from "@/domain/writer";
import { BaseRepo } from "@/db/sqlite/base";

// The writer behind a session, stable across sessions. Keyed by the client name the MCP
// handshake reports, so policy is addressed by that name rather than through a surrogate.
@injectable()
export class SqlitePrincipalsRepo extends BaseRepo implements PrincipalsRepo {
  // A session always resolves to a principal, including one whose host never named itself
  // — otherwise the writes with no identity would sit outside every rule instead of under
  // a rule that can be written for them.
  async resolve(writer: Writer, ts: string): Promise<string> {
    const id = principalOfWriter(writer);

    this.db
      .prepare(
        `INSERT INTO principals (id, kind, label, created_at, last_seen)
         VALUES (?, ?, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`,
      )
      .run(id, kindOf(id), ts, ts);

    return id;
  }

  async find(id: string): Promise<PrincipalRow | undefined> {
    return this.db.prepare("SELECT * FROM principals WHERE id = ?").get(id) as
      PrincipalRow | undefined;
  }

  async list(): Promise<PrincipalRow[]> {
    return this.db
      .prepare("SELECT * FROM principals ORDER BY last_seen DESC")
      .all() as PrincipalRow[];
  }
}

function kindOf(id: string): PrincipalKind {
  if (id === UNATTRIBUTED_PRINCIPAL) return PrincipalKind.UNATTRIBUTED;

  return id.startsWith("cerebrium-") ? PrincipalKind.SYSTEM : PrincipalKind.AGENT;
}
