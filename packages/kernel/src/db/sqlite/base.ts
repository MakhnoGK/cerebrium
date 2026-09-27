import type Database from "better-sqlite3";
import { inject, injectable } from "tsyringe";
import { withBusyRetry } from "@/db/sqlite/retry";

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

  // For a unit of work whose steps are other repositories' async methods; their own `tx`
  // calls nest as savepoints. `fn` must not await real I/O: whatever else this connection
  // runs in the meantime would land inside this transaction.
  protected async txAsync<T>(fn: () => Promise<T>): Promise<T> {
    withBusyRetry(() => this.db.exec("BEGIN IMMEDIATE"));
    try {
      const result = await fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
