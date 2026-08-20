import { injectable } from "tsyringe";
import { BaseRepo } from "@/db/repositories/base";
import type { Writer } from "@/runtime/client-identity";
import { PrincipalKind, UNATTRIBUTED_PRINCIPAL } from "@/core/vocab";

export interface PrincipalRow {
  id: string;
  kind: string;
  label: string | null;
  created_at: string;
  last_seen: string;
}

// The writer behind a session, stable across sessions. Keyed by the client name the MCP
// handshake reports, so policy is addressed by that name rather than through a surrogate.
@injectable()
export class PrincipalsRepo extends BaseRepo {
  // A session always resolves to a principal, including one whose host never named itself
  // — otherwise the writes with no identity would sit outside every rule instead of under
  // a rule that can be written for them.
  resolve(writer: Writer, ts: string): string {
    const id = writer.client ?? UNATTRIBUTED_PRINCIPAL;

    this.db
      .prepare(
        `INSERT INTO principals (id, kind, label, created_at, last_seen)
         VALUES (?, ?, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`,
      )
      .run(id, kindOf(id), ts, ts);

    return id;
  }

  find(id: string): PrincipalRow | undefined {
    return this.db.prepare("SELECT * FROM principals WHERE id = ?").get(id) as
      PrincipalRow | undefined;
  }

  list(): PrincipalRow[] {
    return this.db
      .prepare("SELECT * FROM principals ORDER BY last_seen DESC")
      .all() as PrincipalRow[];
  }
}

function kindOf(id: string): PrincipalKind {
  if (id === UNATTRIBUTED_PRINCIPAL) return PrincipalKind.UNATTRIBUTED;

  return id.startsWith("cerebrium-") ? PrincipalKind.SYSTEM : PrincipalKind.AGENT;
}
