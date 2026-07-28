import type Database from "better-sqlite3";
import { withBusyRetry } from "@/db/retry";
import { inject, injectable } from "tsyringe";

// Common surface for every aggregate repository: the shared connection (single
// writer) and the write-transaction wrapper. Kept minimal on purpose — each repo
// owns its own SQL; only the connection and the transaction discipline are shared.
export const MAX_EMBED_ATTEMPTS = 5;
export const DB_TOKEN = Symbol("db");

@injectable()
export class BaseRepo {
  constructor(@inject(DB_TOKEN) protected readonly db: Database.Database) {}

  // Every write operation goes through here: an IMMEDIATE transaction (takes the write lock
  // at BEGIN, so busy_timeout — not a stale read snapshot — governs contention)
  // wrapped in a busy-retry for the residual SQLITE_BUSY across server processes.
  protected tx<T>(fn: () => T): T {
    const runner = this.db.transaction(fn);
    return withBusyRetry(() => runner.immediate());
  }
}
