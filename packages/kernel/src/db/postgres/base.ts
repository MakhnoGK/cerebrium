import type pg from "pg";
import { inject, injectable } from "tsyringe";
import { PG_TOKEN, type Params, type PgDatabase } from "@/db/postgres/database";

@injectable()
export class PgBaseRepo {
  constructor(@inject(PG_TOKEN) protected readonly db: PgDatabase) {}

  protected async all<T extends pg.QueryResultRow>(sql: string, params?: Params): Promise<T[]> {
    return (await this.db.query<T>(sql, params)).rows;
  }

  protected async one<T extends pg.QueryResultRow>(
    sql: string,
    params?: Params,
  ): Promise<T | undefined> {
    return (await this.db.query<T>(sql, params)).rows[0];
  }

  // Every write goes through the write lane, a single statement included.
  protected async run(sql: string, params?: Params): Promise<number> {
    return this.tx(async () => (await this.db.query(sql, params)).rowCount ?? 0);
  }

  protected tx<T>(fn: () => Promise<T>): Promise<T> {
    return this.db.tx(fn);
  }
}
