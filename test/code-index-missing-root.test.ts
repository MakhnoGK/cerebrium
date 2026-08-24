import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { container } from "tsyringe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodeIndexService } from "@/application/services";
import type { IndexStats } from "@/core/types";
import { setup } from "@test/helpers";

const SRC = `export function hashToken(input: string): string {
  return input.split("").reverse().join("");
}
export const TTL = 900;
`;

const NAME = "vanishing";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mk-missing-root-"));
  writeFileSync(join(root, "crypto.ts"), SRC);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const index = (): Promise<IndexStats> =>
  container
    .resolve(CodeIndexService)
    .indexTarget({ name: NAME, root }, { session_id: "sys-index" });

const liveSymbols = (db: { prepare: (s: string) => { get: () => unknown } }): number =>
  (
    db
      .prepare("SELECT COUNT(*) c FROM nodes WHERE type='symbol' AND invalidated_at IS NULL")
      .get() as { c: number }
  ).c;

describe("code_index against a root that is not on disk", () => {
  it("should keep every symbol when the checkout has moved away since the last index", async () => {
    // Given — indexed once while the tree was there.
    const { db } = setup();
    const first = await index();
    const before = liveSymbols(db);

    expect(first.symbols_added).toBeGreaterThan(0);
    expect(before).toBeGreaterThan(0);

    // When — the tree disappears (moved home, unmounted volume, stale remembered root).
    rmSync(root, { recursive: true, force: true });

    const second = await index();

    // Then
    expect(second.symbols_invalidated).toBe(0);
    expect(liveSymbols(db)).toBe(before);
  });

  it("should report the root as missing rather than as an empty repo when it is gone", async () => {
    // Given
    setup();
    await index();
    rmSync(root, { recursive: true, force: true });

    // When
    const stats = await index();

    // Then
    expect(stats.root_missing).toBe(true);
    expect(stats.files_scanned).toBe(0);
    expect(stats.files_indexed).toBe(0);
  });

  it("should not claim a missing root when the directory is merely empty", async () => {
    // Given — the root exists but holds nothing indexable.
    const { db } = setup();
    await index();
    const before = liveSymbols(db);

    rmSync(join(root, "crypto.ts"));

    // When
    const stats = await index();

    // Then — a genuinely empty tree still retires what it no longer has.
    expect(stats.root_missing).toBeUndefined();
    expect(stats.symbols_invalidated).toBeGreaterThan(0);
    expect(liveSymbols(db)).toBeLessThan(before);
  });
});
