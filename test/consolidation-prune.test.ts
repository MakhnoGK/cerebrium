import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { container } from "tsyringe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsolidationRecommendation } from "@/domain/ports/consolidation-provider";
import { ConsolidationWorker } from "@/application/workers";
import type { Envelope } from "@/db/repo";
import { ConsolidationKind, MemoryKind } from "@/core/vocab";
import { CodeIndexTool } from "@/presentation/mcp/tools/code-index";
import { ConsolidateApplyTool } from "@/presentation/mcp/tools/consolidate-apply";
import { SearchTool } from "@/presentation/mcp/tools/search";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup, TestEnv } from "@test/helpers";

const SRC = `/** prunable widget helper for the gadget subsystem */
export function prunableWidget(): number {
  return 42;
}
`;

let root: string;

// Index the file, then simulate a removed file that left its symbols dangling by
// deleting the code_files row directly — the drift the Tier-1 sweep reconciles.
async function orphanSymbol(env: TestEnv): Promise<{ s: string; symbolId: string }> {
  const s = (await container.resolve(SessionStartTool).invoke({})).session_id;
  const stats = (await container.resolve(CodeIndexTool).invoke({ session_id: s, path: root })) as {
    repo: string;
  };
  const symbolId = env.code.findSymbolsByName("prunableWidget", stats.repo, 1)[0]!.envelope.id;
  env.db.prepare("DELETE FROM code_files WHERE repo = ?").run(stats.repo);
  return { s, symbolId };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mk-prune-"));
  mkdirSync(join(root, "gadget"), { recursive: true });
  writeFileSync(join(root, "gadget", "widget.ts"), SRC);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.MEMORY_CONSOLIDATE_PRUNE;
});

describe("Tier-1 mirror prune", () => {
  it("should auto-invalidate an orphaned symbol so it drops out of retrieval", async () => {
    // Given
    const env = setup();
    const { s, symbolId } = await orphanSymbol(env);
    expect(env.nodes.envelope(symbolId)!.invalidated).toBe(false);

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.pruned).toBeGreaterThanOrEqual(1); // module symbol + the function
    expect(env.nodes.envelope(symbolId)!.invalidated).toBe(true);

    // gone from default search, present under history
    const normal = (await container.resolve(SearchTool).invoke({
      session_id: s,
      query: "prunable widget gadget",
      types: ["symbol"],
      mode: "text",
      limit: 10,
    })) as { results: Envelope[] };
    expect(normal.results.some((x) => x.id === symbolId)).toBe(false);
    const hist = (await container.resolve(SearchTool).invoke({
      session_id: s,
      query: "prunable widget gadget",
      types: ["symbol"],
      mode: "text",
      history: true,
      limit: 10,
    })) as { results: Envelope[] };
    expect(hist.results.some((x) => x.id === symbolId)).toBe(true);
  });

  it("should never touch authored memory", async () => {
    // Given
    const env = setup();
    const { s } = await orphanSymbol(env);
    const fact = (await container.resolve(WriteTool).invoke({
      session_id: s,
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title: "Keep me",
      content: "a durable fact that must survive the prune sweep",
    })) as Envelope;

    // When / Then — the dead-mirror detector returns only the orphaned symbol, never the fact.
    expect(env.consolidation.deadMirrorNodes(50)).not.toContain(fact.id);
    await container.resolve(ConsolidationWorker).tick();
    expect(env.nodes.envelope(fact.id)!.invalidated).toBe(false);
  });

  it("should queue a prune candidate under suggest and invalidate on apply", async () => {
    // Given
    process.env.MEMORY_CONSOLIDATE_PRUNE = "suggest";
    const env = setup();
    const { s, symbolId } = await orphanSymbol(env);

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.prune_suggested).toBeGreaterThanOrEqual(1);
    expect(env.nodes.envelope(symbolId)!.invalidated).toBe(false);

    const cand = env.consolidation
      .pendingCandidates({ kind: ConsolidationKind.PRUNE })
      .find((c) => c.member_ids[0] === symbolId);
    expect(cand).toBeDefined();
    await container
      .resolve(ConsolidateApplyTool)
      .invoke({ session_id: s, id: cand!.id, decision: ConsolidationRecommendation.APPLY });
    expect(env.nodes.envelope(symbolId)!.invalidated).toBe(true);
  });

  it("should prune nothing under the off posture", async () => {
    // Given
    process.env.MEMORY_CONSOLIDATE_PRUNE = "off";
    const env = setup();
    const { symbolId } = await orphanSymbol(env);

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.pruned).toBe(0);
    expect(r.prune_suggested).toBe(0);
    expect(env.nodes.envelope(symbolId)!.invalidated).toBe(false);
  });
});
