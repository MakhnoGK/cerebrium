import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { nowIso } from "@/core/ids";

const here = dirname(fileURLToPath(import.meta.url));
const requireCjs = createRequire(import.meta.url);

export function defaultDbPath(): string {
  return join(homedir(), ".cerebrium", "memory.db");
}

export function openDatabase(dbPath = defaultDbPath()): Database.Database {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 15000");
  db.pragma("foreign_keys = ON");

  // sqlite-vec must load before a migration creates the chunk_vec vec0 table.
  sqliteVec.load(db);

  // Migrations are the single source of truth: a fresh DB is built entirely by
  // running 000_baseline -> NNN in order. schema.sql is a derived snapshot, never
  // executed here (a drift-guard test keeps it accurate).
  runMigrations(db);
  return db;
}

// Read-only handle for inspection tooling (the stats CLI). Opens without running
// schema/migrations — those are writes and would violate the single-writer
// invariant. sqlite-vec is still loaded so the vec0 table is a known module.
export function openDatabaseReadonly(dbPath = defaultDbPath()): Database.Database {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  sqliteVec.load(db);
  return db;
}

function runMigrations(db: Database.Database): void {
  const dir = join(here, "migrations");
  if (!existsSync(dir)) return;
  // Bootstrap the ledger before reading it — on a fresh DB nothing exists yet, and
  // schema.sql is no longer executed to create it. 000_baseline recreates this table
  // with IF NOT EXISTS, so this is safe on existing DBs too.
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set<string>(
    db
      .prepare("SELECT id FROM schema_migrations")
      .all()
      .map((r) => (r as { id: string }).id),
  );
  // `.cjs` migrations exist for data transforms SQLite can't express (e.g. a hash
  // recompute); they export `up(db)` and are require()d synchronously so this stays
  // sync. They sort in with `.sql` by their numeric filename prefix.
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql") || f.endsWith(".cjs"))
    .sort();
  const record = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
  for (const file of files) {
    if (applied.has(file)) continue;
    db.transaction(() => {
      if (file.endsWith(".cjs")) {
        (requireCjs(join(dir, file)) as { up: (db: Database.Database) => void }).up(db);
      } else {
        db.exec(readFileSync(join(dir, file), "utf8"));
      }
      record.run(file, nowIso());
    })();
  }
}
