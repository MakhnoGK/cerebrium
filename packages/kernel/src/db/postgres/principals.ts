import { injectable } from "tsyringe";
import { PrincipalKind, UNATTRIBUTED_PRINCIPAL } from "@cerebrium/contracts/vocab";
import type { PrincipalRow, PrincipalsRepo } from "@/domain/ports/storage";
import type { Writer } from "@/domain/writer";
import { PgBaseRepo } from "@/db/postgres/base";

@injectable()
export class PgPrincipalsRepo extends PgBaseRepo implements PrincipalsRepo {
  async resolve(writer: Writer, ts: string): Promise<string> {
    const id = writer.client ?? UNATTRIBUTED_PRINCIPAL;

    await this.run(
      `INSERT INTO principals (id, kind, label, created_at, last_seen)
       VALUES (@id, @kind, NULL, @ts, @ts)
       ON CONFLICT (id) DO UPDATE SET last_seen = excluded.last_seen`,
      { id, kind: kindOf(id), ts },
    );

    return id;
  }

  async find(id: string): Promise<PrincipalRow | undefined> {
    return this.one<PrincipalRow>("SELECT * FROM principals WHERE id = @id", { id });
  }

  async list(): Promise<PrincipalRow[]> {
    return this.all<PrincipalRow>("SELECT * FROM principals ORDER BY last_seen DESC, id");
  }
}

function kindOf(id: string): PrincipalKind {
  if (id === UNATTRIBUTED_PRINCIPAL) return PrincipalKind.UNATTRIBUTED;

  return id.startsWith("cerebrium-") ? PrincipalKind.SYSTEM : PrincipalKind.AGENT;
}
