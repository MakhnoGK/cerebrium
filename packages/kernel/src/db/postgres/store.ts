import { inject, injectable } from "tsyringe";
import type { Store } from "@/domain/ports/storage";
import { PG_TOKEN, type PgDatabase } from "@/db/postgres/database";

@injectable()
export class PgStore implements Store {
  readonly backend = "postgres" as const;
  readonly capabilities = { codeIndex: false };

  constructor(@inject(PG_TOKEN) private readonly db: PgDatabase) {}

  get identity(): string {
    return this.db.identity;
  }

  async ping(): Promise<void> {
    await this.db.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
