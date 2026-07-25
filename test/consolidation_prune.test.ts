import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCtx } from "@test/helpers";
import { ConsolidationWorker } from "@/consolidation/worker";
import type { Ctx } from "@/tools/context";
import type BetterSqlite3 from "better-sqlite3";
import type { Repo } from "@/db/repo";
import type { Envelope } from "@/db/repo";
import { SessionStartTool } from "../src/tools/session_start";
import { CodeIndexTool } from "../src/tools/code_index";
import { WriteTool } from "../src/tools/write";
import { SearchTool } from "../src/tools/search";
import { ConsolidateApplyTool } from "../src/tools/consolidate_apply";

const session_start = new SessionStartTool();
const code_index = new CodeIndexTool();
const write = new WriteTool();
const search = new SearchTool();
const consolidate_apply = new ConsolidateApplyTool();

const SRC = `/** prunable widget helper for the gadget subsystem */
export function prunableWidget(): number {
  return 42;
}
`;

let root: string;

// Index the file, then simulate a removed file that left its symbols dangling by
// deleting the code_files row directly — the drift the Tier-1 sweep reconciles.
async function orphanSymbol(
  ctx: Ctx,
  repo: Repo,
  db: BetterSqlite3.Database,
): Promise<{ s: string; symbolId: string }> {
  const s = (await session_start.invoke(ctx, {})).session_id;
  const stats = (await code_index.invoke(ctx, { session_id: s, path: root })) as { repo: string };
  const symbolId = repo.findSymbolsByName("prunableWidget", stats.repo, 1)[0]!.envelope.id;
  db.prepare("DELETE FROM code_files WHERE repo = ?").run(stats.repo);
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

describe("Tier-1 mirror prune (P5 §9-bis)", () => {
  it("auto invalidates an orphaned symbol and it drops out of retrieval", async () => {
    const { ctx, repo, db } = makeCtx();
    const { s, symbolId } = await orphanSymbol(ctx, repo, db);
    expect(repo.envelope(symbolId)!.invalidated).toBe(false);

    const r = await new ConsolidationWorker(repo, ctx.consolidator, ctx.now).tick();
    expect(r.pruned).toBeGreaterThanOrEqual(1); // module symbol + the function
    expect(repo.envelope(symbolId)!.invalidated).toBe(true);

    // gone from default search, present under history
    const normal = (await search.invoke(ctx, {
      session_id: s,
      query: "prunable widget gadget",
      types: ["symbol"],
      mode: "text",
      limit: 10,
    })) as { results: Envelope[] };
    expect(normal.results.some((x) => x.id === symbolId)).toBe(false);
    const hist = (await search.invoke(ctx, {
      session_id: s,
      query: "prunable widget gadget",
      types: ["symbol"],
      mode: "text",
      history: true,
      limit: 10,
    })) as { results: Envelope[] };
    expect(hist.results.some((x) => x.id === symbolId)).toBe(true);
  });

  it("never touches authored memory", async () => {
    const { ctx, repo, db } = makeCtx();
    const { s } = await orphanSymbol(ctx, repo, db);
    const fact = (await write.invoke(ctx, {
      session_id: s,
      memory_kind: "semantic",
      type: "fact",
      title: "Keep me",
      content: "a durable fact that must survive the prune sweep",
    })) as Envelope;

    // the dead-mirror detector returns only the orphaned symbol, never the fact
    expect(repo.deadMirrorNodes(50)).not.toContain(fact.id);
    await new ConsolidationWorker(repo, ctx.consolidator, ctx.now).tick();
    expect(repo.envelope(fact.id)!.invalidated).toBe(false);
  });

  it("suggest posture queues a prune candidate; apply invalidates", async () => {
    process.env.MEMORY_CONSOLIDATE_PRUNE = "suggest";
    const { ctx, repo, db } = makeCtx();
    const { s, symbolId } = await orphanSymbol(ctx, repo, db);

    const r = await new ConsolidationWorker(repo, ctx.consolidator, ctx.now).tick();
    expect(r.prune_suggested).toBeGreaterThanOrEqual(1);
    expect(repo.envelope(symbolId)!.invalidated).toBe(false);

    const cand = repo
      .pendingCandidates({ kind: "prune" })
      .find((c) => c.member_ids[0] === symbolId);
    expect(cand).toBeDefined();
    await consolidate_apply.invoke(ctx, { session_id: s, id: cand!.id, decision: "accept" });
    expect(repo.envelope(symbolId)!.invalidated).toBe(true);
  });

  it("off posture prunes nothing", async () => {
    process.env.MEMORY_CONSOLIDATE_PRUNE = "off";
    const { ctx, repo, db } = makeCtx();
    const { symbolId } = await orphanSymbol(ctx, repo, db);
    const r = await new ConsolidationWorker(repo, ctx.consolidator, ctx.now).tick();
    expect(r.pruned).toBe(0);
    expect(r.prune_suggested).toBe(0);
    expect(repo.envelope(symbolId)!.invalidated).toBe(false);
  });
});
