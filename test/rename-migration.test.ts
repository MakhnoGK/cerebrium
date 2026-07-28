import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { stableSymbolId } from "@/code/extract";
import { indexRepo } from "@/code/indexer";
import { setup } from "@test/helpers";

const require = createRequire(import.meta.url);
const { up } = require("../src/db/migrations/006_rename_third_brain_to_cerebrium.cjs") as {
  up: (db: import("better-sqlite3").Database) => void;
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});
function tmpRepo(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "rename-"));
  dirs.push(d);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
  return d;
}

describe("Migration 006: rename third-brain -> cerebrium", () => {
  it("should relabel the mirror, recompute symbol identity, and leave other repos intact when the rename runs", async () => {
    // Given
    const { code, queue, db, clock } = setup();
    const now = () => clock.t;

    const oldRoot = tmpRepo({
      "a.ts": "export function alpha() { return beta(); }\nfunction beta() {}\n",
    });
    await indexRepo(code, queue, { name: "third-brain", root: oldRoot }, { session_id: "s", now });
    code.setRepoProvenance("third-brain", oldRoot, "main", "deadbee", false, clock.t);

    const otherRoot = tmpRepo({ "b.ts": "export function gamma() {}\n" });
    await indexRepo(code, queue, { name: "other-app", root: otherRoot }, { session_id: "s", now });

    // Authored memories carrying legacy project names.
    const insNode = db.prepare(
      `INSERT INTO nodes (id, memory_kind, type, title, project, valid_from, created_by_session, created_at)
       VALUES (?, 'semantic', 'fact', ?, ?, ?, 's', ?)`,
    );
    insNode.run("n-tb", "tb note", "third-brain", clock.t, clock.t);
    insNode.run("n-mk", "mk note", "memory-kernel", clock.t, clock.t);
    insNode.run("n-other", "keep", "other-app", clock.t, clock.t);

    const otherSymsBefore = db
      .prepare(
        "SELECT node_id, n.external_id FROM symbols s JOIN nodes n ON n.id = s.node_id WHERE s.repo = 'other-app'",
      )
      .all() as { node_id: string; external_id: string }[];

    // When
    up(db);

    // Then — no lingering old names anywhere.
    expect(db.prepare("SELECT COUNT(*) c FROM symbols WHERE repo = 'third-brain'").get()).toEqual({
      c: 0,
    });
    expect(
      db.prepare("SELECT COUNT(*) c FROM code_files WHERE repo = 'third-brain'").get(),
    ).toEqual({ c: 0 });
    expect(
      db.prepare("SELECT COUNT(*) c FROM code_repos WHERE repo = 'third-brain'").get(),
    ).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM nodes WHERE project = 'third-brain'").get()).toEqual({
      c: 0,
    });
    expect(
      db.prepare("SELECT COUNT(*) c FROM nodes WHERE project = 'memory-kernel'").get(),
    ).toEqual({ c: 0 });

    // Then — code_repos row moved to the new name and root (resolved from the repo layout).
    const expectedRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    expect(
      db.prepare("SELECT repo, root FROM code_repos WHERE repo = 'cerebrium'").get(),
    ).toMatchObject({
      repo: "cerebrium",
      root: expectedRoot,
    });

    // Then — every renamed symbol's external_id equals the cerebrium-keyed hash.
    const renamed = db
      .prepare(
        `SELECT s.path, s.qualified, s.symbol_kind AS kind, n.external_id, n.project
         FROM symbols s JOIN nodes n ON n.id = s.node_id WHERE s.repo = 'cerebrium'`,
      )
      .all() as {
      path: string;
      qualified: string;
      kind: string;
      external_id: string;
      project: string;
    }[];
    expect(renamed.length).toBeGreaterThan(0);
    for (const r of renamed) {
      expect(r.external_id).toBe(stableSymbolId("cerebrium", r.path, r.qualified, r.kind));
      expect(r.project).toBe("cerebrium");
    }

    // Then — authored memories consolidated onto the new name; unrelated project untouched.
    expect(
      db
        .prepare(
          "SELECT COUNT(*) c FROM nodes WHERE project = 'cerebrium' AND memory_kind != 'mirror'",
        )
        .get(),
    ).toEqual({ c: 2 });
    expect(db.prepare("SELECT project FROM nodes WHERE id = 'n-other'").get()).toEqual({
      project: "other-app",
    });

    // Then — the other repo's mirror is byte-for-byte untouched.
    const otherSymsAfter = db
      .prepare(
        "SELECT node_id, n.external_id FROM symbols s JOIN nodes n ON n.id = s.node_id WHERE s.repo = 'other-app'",
      )
      .all() as { node_id: string; external_id: string }[];
    expect(otherSymsAfter).toEqual(otherSymsBefore);
  });

  it("should be idempotent and a no-op when no legacy names are present", async () => {
    // Given
    const { code, queue, db, clock } = setup();
    const now = () => clock.t;
    const root = tmpRepo({ "a.ts": "export function alpha() {}\n" });
    await indexRepo(code, queue, { name: "third-brain", root }, { session_id: "s", now });

    // When
    up(db);
    const snapshot = db.prepare("SELECT id, external_id, project FROM nodes ORDER BY id").all();
    up(db); // second run changes nothing

    // Then
    expect(db.prepare("SELECT id, external_id, project FROM nodes ORDER BY id").all()).toEqual(
      snapshot,
    );
  });

  it("should add nothing when re-indexing under the new name after the rename", async () => {
    // Given
    const { code, queue, db, clock } = setup();
    const now = () => clock.t;
    const root = tmpRepo({
      "a.ts": "export function alpha() { return beta(); }\nfunction beta() {}\n",
    });
    await indexRepo(code, queue, { name: "third-brain", root }, { session_id: "s", now });
    up(db);

    // When — the renamed mirror must be recognised as current by an index run under the new name.
    const stats = await indexRepo(
      code,
      queue,
      { name: "cerebrium", root },
      { session_id: "s", now },
    );

    // Then
    expect(stats.symbols_added).toBe(0);
    expect(stats.symbols_invalidated).toBe(0);
    const active = db
      .prepare(
        "SELECT COUNT(*) c FROM symbols s JOIN nodes n ON n.id = s.node_id WHERE s.repo = 'cerebrium' AND n.invalidated_at IS NULL",
      )
      .get() as { c: number };
    expect(active.c).toBeGreaterThan(0);
  });
});
