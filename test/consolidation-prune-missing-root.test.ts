import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { container } from "tsyringe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsolidationWorker } from "@/application/workers";
import { CodeIndexTool } from "@/presentation/mcp/tools/code-index";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { setup, type TestEnv } from "@test/helpers";

const SRC = `export function prunableWidget(): number {
  return 41;
}
`;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mk-prune-missing-"));
  mkdirSync(join(root, "gadget"), { recursive: true });
  writeFileSync(join(root, "gadget", "widget.ts"), SRC);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// Reproduces the shape the live store was left in: symbols alive, their `code_files` rows
// gone. That is what `removeFile` leaves behind, and it is indistinguishable from a genuine
// orphan unless the repo's root is consulted.
async function orphanedRepo(env: TestEnv): Promise<{ repo: string; symbolId: string }> {
  const s = (await container.resolve(SessionStartTool).invoke({})).session_id;
  const stats = (await container.resolve(CodeIndexTool).invoke({ session_id: s, path: root })) as {
    repo: string;
  };
  const symbolId = env.code.findSymbolsByName("prunableWidget", stats.repo, 1)[0]!.envelope.id;

  env.db.prepare("DELETE FROM code_files WHERE repo = ?").run(stats.repo);
  env.db
    .prepare("UPDATE code_repos SET indexed_at = ? WHERE repo = ?")
    .run("2099-01-01T00:00:00.000Z", stats.repo);

  return { repo: stats.repo, symbolId };
}

describe("mirror prune against a repo whose root is not on disk", () => {
  it("should leave the symbols alone when the checkout has moved away", async () => {
    // Given — orphaned rows, and then the tree itself disappears.
    const env = setup();
    const { symbolId } = await orphanedRepo(env);

    rmSync(root, { recursive: true, force: true });

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.pruned).toBe(0);
    expect(env.nodes.envelope(symbolId)!.invalidated).toBe(false);
  });

  it("should still prune a genuine orphan when the root is present", async () => {
    // Given — same orphaning, but the tree is still there.
    const env = setup();
    const { symbolId } = await orphanedRepo(env);

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.pruned).toBeGreaterThanOrEqual(1);
    expect(env.nodes.envelope(symbolId)!.invalidated).toBe(true);
  });

  it("should exclude the named repos when the repository is asked directly", async () => {
    // Given
    const env = setup();
    const { repo, symbolId } = await orphanedRepo(env);

    // When
    const all = env.consolidation.deadMirrorNodes(50);
    const excluded = env.consolidation.deadMirrorNodes(50, [repo]);

    // Then
    expect(all).toContain(symbolId);
    expect(excluded).not.toContain(symbolId);
  });
});
