import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { nowIso } from "@/core/ids";

const here = dirname(fileURLToPath(import.meta.url));

// The bundle carries them as `pg-migrations/` beside the bins, where `migrations/` is
// SQLite's (see scripts/copy-assets.mjs); from source they sit next to this module.
export function migrationsDir(): string {
  for (const candidate of [join(here, "pg-migrations"), join(here, "migrations")]) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(`no Postgres migrations found beside ${here}`);
}

export function migrationFiles(dir = migrationsDir()): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

// The caller holds the migrate advisory lock. Each file commits on its own.
export async function runMigrations(
  client: pg.PoolClient,
  dir = migrationsDir(),
): Promise<string[]> {
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );

  const { rows } = await client.query<{ id: string }>("SELECT id FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.id));
  const ran: string[] = [];

  for (const file of migrationFiles(dir)) {
    if (applied.has(file)) continue;

    try {
      await client.query("BEGIN");
      await client.query(readFileSync(join(dir, file), "utf8"));
      await client.query("INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)", [
        file,
        nowIso(),
      ]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error(`postgres migration ${file} failed: ${(err as Error).message}`, {
        cause: err,
      });
    }

    ran.push(file);
  }

  return ran;
}

export async function assertMigrated(client: pg.PoolClient, dir = migrationsDir()): Promise<void> {
  const { rows } = await client
    .query<{ id: string }>("SELECT id FROM schema_migrations")
    .catch(() => ({ rows: [] as { id: string }[] }));
  const applied = new Set(rows.map((r) => r.id));
  const missing = migrationFiles(dir).filter((f) => !applied.has(f));

  if (missing.length) {
    throw new Error(
      `the Postgres store is not migrated (missing ${missing.join(", ")}); start a writer first`,
    );
  }
}
