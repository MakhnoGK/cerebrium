import { injectable } from "tsyringe";
import type { PrincipalTokenRow, PrincipalTokensRepo } from "@/domain/ports/storage";
import { PgBaseRepo } from "@/db/postgres/base";

const COLUMNS = "id, principal_id, label, created_at, last_used_at, revoked_at";

@injectable()
export class PgPrincipalTokensRepo extends PgBaseRepo implements PrincipalTokensRepo {
  async insert(
    row: Omit<PrincipalTokenRow, "last_used_at" | "revoked_at">,
    hash: string,
  ): Promise<void> {
    await this.run(
      `INSERT INTO principal_tokens (id, principal_id, token_hash, label, created_at)
       VALUES (@id, @principal_id, @hash, @label, @created_at)`,
      { ...row, hash },
    );
  }

  async findActiveByHash(hash: string): Promise<PrincipalTokenRow | undefined> {
    return this.one<PrincipalTokenRow>(
      `SELECT ${COLUMNS} FROM principal_tokens WHERE token_hash = @hash AND revoked_at IS NULL`,
      { hash },
    );
  }

  async list(): Promise<PrincipalTokenRow[]> {
    return this.all<PrincipalTokenRow>(
      `SELECT ${COLUMNS} FROM principal_tokens ORDER BY created_at, id`,
    );
  }

  async revoke(id: string, ts: string): Promise<boolean> {
    return (
      (await this.run(
        "UPDATE principal_tokens SET revoked_at = @ts WHERE id = @id AND revoked_at IS NULL",
        { id, ts },
      )) === 1
    );
  }

  async touch(id: string, ts: string): Promise<void> {
    await this.run("UPDATE principal_tokens SET last_used_at = @ts WHERE id = @id", { id, ts });
  }
}
