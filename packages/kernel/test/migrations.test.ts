import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/db/database";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../src/db/schema.sql"), "utf8");

const MIGRATION_IDS = [
  "000_baseline.sql",
  "001_phase2_embeddings.sql",
  "002_phase3b_code.sql",
  "003_worker_lease.sql",
  "004_code_provenance.sql",
  "005_code_repos_root.sql",
  "006_rename_third_brain_to_cerebrium.cjs",
  "007_phase3a_mirrors.sql",
  "008_consolidation.sql",
  "009_annotations.sql",
  "010_node_usage.cjs",
  "011_event_time.cjs",
  "012_repoint_dangling_edges.cjs",
  "013_split_vector_pools.cjs",
  "014_purge_stale_chunk_vectors.cjs",
  "015_chunk_fts.sql",
  "016_repair_post_supersede_edges.cjs",
  "017_retire_stale_similarities.cjs",
  "018_consolidation_runs.sql",
  "019_candidate_attempt.cjs",
  "020_session_writer.cjs",
  "021_merge_delayed.cjs",
  "022_process_registry.sql",
  "023_process_model_state.sql",
  "024_principals.cjs",
  "025_normalize_edge_timestamps.cjs",
  "026_consolidation_stage_ms.cjs",
  "027_wikilink_counters.cjs",
  "028_retire_third_party_symbols.cjs",
  "029_documents_suggested.cjs",
  "030_documents_linked.cjs",
  "031_jobs.sql",
  "032_review_decisions.sql",
];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});
function tmpDbPath(): string {
  const d = mkdtempSync(join(tmpdir(), "cbm-mig-"));
  dirs.push(d);
  return join(d, "memory.db");
}

// sqlite_master.sql preserves the author's exact text (comments, whitespace,
// IF NOT EXISTS), which differs between 000_baseline and schema.sql even when the
// structure is identical. Normalize those away so the drift guard compares structure.
function normalize(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, "")
    .replace(/if not exists/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1") // canonicalize spacing around parens/commas
    .trim();
}
function normalizedSchema(db: Database.Database): string[] {
  return (
    db
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as { type: string; name: string; sql: string }[]
  ).map((o) => `${o.type} ${o.name}: ${normalize(o.sql)}`);
}
function tableNames(db: Database.Database): Set<string> {
  return new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name),
  );
}

describe("Migrations as single source of truth", () => {
  it("should build a fresh DB entirely from migrations when the database is opened", () => {
    // Given / When
    const db = openDatabase(":memory:");

    // Then
    const tables = tableNames(db);
    for (const t of [
      "nodes",
      "revisions",
      "edges",
      "sessions",
      "events",
      "node_fts",
      "chunks",
      "chunk_vec",
      "code_vec",
      "embedding_meta",
      "embedding_queue",
      "code_files",
      "symbols",
      "schema_migrations",
      "worker_lease",
      "code_repos",
      "mirror_sources",
      "mirror_records",
      "consolidation_candidates",
      "revision_annotations",
    ]) {
      expect(tables.has(t), `missing table ${t}`).toBe(true);
    }
    const applied = (
      db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: string }[]
    ).map((r) => r.id);
    expect(applied).toEqual(MIGRATION_IDS);
    db.close();
  });

  it("should re-apply a migration without error when its ledger row is missing", () => {
    // Given — what the loser of a cold-start race sees: work already done, ledger says no.
    const path = tmpDbPath();
    const first = openDatabase(path);
    first.prepare("DELETE FROM schema_migrations WHERE id = ?").run(MIGRATION_IDS[0]!);
    first.close();

    // When / Then
    const second = openDatabase(path);
    expect(
      (
        second.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: string }[]
      ).map((r) => r.id),
    ).toEqual(MIGRATION_IDS);
    second.close();
  });

  it("should stay byte-equivalent to what migrations build when schema.sql is compared (drift guard)", () => {
    // Given / When
    const fromMigrations = openDatabase(":memory:");
    const fromSchema = new Database(":memory:");
    sqliteVec.load(fromSchema);
    fromSchema.exec(schemaSql);

    // Then
    expect(normalizedSchema(fromMigrations)).toEqual(normalizedSchema(fromSchema));

    fromMigrations.close();
    fromSchema.close();
  });

  it("should not re-apply migrations when an existing DB is reopened", () => {
    // Given
    const path = tmpDbPath();
    const a = openDatabase(path);
    const first = a.prepare("SELECT id, applied_at FROM schema_migrations ORDER BY id").all();
    a.close();

    // When
    const b = openDatabase(path);
    const second = b.prepare("SELECT id, applied_at FROM schema_migrations ORDER BY id").all();

    // Then
    // Same rows with the same applied_at => nothing re-ran on the second open.
    expect(second).toEqual(first);
    b.close();
  });

  it("should upgrade a legacy DB without error or data loss when tables are present but 000 is not recorded", () => {
    // Given
    const path = tmpDbPath();

    // Simulate the OLD startup: exec schema.sql directly and record only 001..006 —
    // exactly the state a production DB is in before this change.
    const legacy = new Database(path);
    sqliteVec.load(legacy);
    legacy.exec(schemaSql);
    const ins = legacy.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
    for (const id of MIGRATION_IDS.filter((m) => m !== "000_baseline.sql")) {
      ins.run(id, "2026-01-01T00:00:00.000Z");
    }
    legacy
      .prepare(
        `INSERT INTO nodes (id, memory_kind, type, title, valid_from, created_by_session, created_at)
         VALUES ('keep', 'semantic', 'fact', 't', 't', 's', 't')`,
      )
      .run();
    legacy.close();

    // When
    const upgraded = openDatabase(path);
    const applied = (
      upgraded.prepare("SELECT id FROM schema_migrations").all() as { id: string }[]
    ).map((r) => r.id);

    // Then
    // 000 gets recorded (ran as an idempotent no-op); nothing else re-ran; data intact.
    expect(applied).toContain("000_baseline.sql");
    expect(applied.sort()).toEqual([...MIGRATION_IDS].sort());
    expect(upgraded.prepare("SELECT COUNT(*) c FROM nodes").get()).toEqual({ c: 1 });
    upgraded.close();
  });
});
