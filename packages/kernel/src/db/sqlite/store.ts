import type Database from "better-sqlite3";
import { inject, injectable } from "tsyringe";
import type { Store } from "@/domain/ports/storage";
import { DB_TOKEN } from "@/db/sqlite/base";

@injectable()
export class SqliteStore implements Store {
  readonly backend = "sqlite" as const;
  readonly capabilities = { codeIndex: true, principalTokens: false };

  constructor(@inject(DB_TOKEN) private readonly db: Database.Database) {}

  get identity(): string {
    return this.db.name;
  }

  async ping(): Promise<void> {
    this.db.prepare("SELECT 1").get();
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
