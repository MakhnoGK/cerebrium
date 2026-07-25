import { describe, it, expect, afterEach } from "vitest";
import { makeCtx } from "./helpers";
import type { Ctx } from "@/tools/context";
import type {
  ConsolidationProvider,
  ConsolidationResult,
  ReconcileResult,
  ReconcileTask,
} from "@/consolidation/provider";
import { SessionStartTool } from "../src/tools/session_start";
import { WriteTool } from "../src/tools/write";

const session_start = new SessionStartTool();
const write = new WriteTool();

// An enabled provider double: it only judges duplicates. `generate` is unused here.
class FakeJudge implements ConsolidationProvider {
  readonly name = "fake";
  readonly version = "1";
  readonly enabled = true;
  calls = 0;
  constructor(private readonly verdict: (t: ReconcileTask) => ReconcileResult) {}
  generate(): Promise<ConsolidationResult> {
    return Promise.reject(new Error("not used"));
  }
  reconcile(task: ReconcileTask): Promise<ReconcileResult> {
    this.calls++;
    return Promise.resolve(this.verdict(task));
  }
}

const P = "billing";
const ORIGINAL =
  "Access tokens live fifteen minutes before they expire and then must be refreshed by the client";

type WriteOut = Record<string, unknown> & {
  id: string;
  similar_existing?: { id: string; score: number }[];
  reconcile?: ReconcileResult;
};

async function session(ctx: Ctx, project?: string): Promise<string> {
  return (await session_start.invoke(ctx, { project })).session_id;
}
function writeFact(ctx: Ctx, s: string, title: string, content: string): Promise<WriteOut> {
  return write.invoke(ctx, {
    session_id: s,
    memory_kind: "semantic",
    type: "fact",
    title,
    content,
    project: P,
  }) as Promise<WriteOut>;
}

afterEach(() => {
  delete process.env.MEMORY_CONSOLIDATE_RECONCILE;
});

describe("write-time reconcile", () => {
  it("sharpens a near-duplicate into a judged action naming the target", async () => {
    const judge = new FakeJudge((t) => ({
      action: "update",
      target_id: t.candidates[0]!.id,
      reason: "refines the existing token TTL fact",
    }));
    const { ctx, worker } = makeCtx({ consolidator: judge });
    const s = await session(ctx, P);
    const original = await writeFact(ctx, s, "Token TTL", ORIGINAL);
    await worker.tick(); // embed the original so the vector dedup probe finds it

    const dup = await writeFact(ctx, s, "Token TTL", ORIGINAL);
    expect(dup.similar_existing?.[0]?.id).toBe(original.id);
    expect(dup.reconcile).toEqual({
      action: "update",
      target_id: original.id,
      reason: "refines the existing token TTL fact",
    });
    // The judge saw the resembling record with its full content, not just a summary.
    expect(judge.calls).toBe(1);
  });

  it("stays silent when there is no near-duplicate (no judge call)", async () => {
    const judge = new FakeJudge(() => ({ action: "update", target_id: "x", reason: "" }));
    const { ctx, worker } = makeCtx({ consolidator: judge });
    const s = await session(ctx, P);
    await writeFact(ctx, s, "Token TTL", ORIGINAL);
    await worker.tick();

    const unrelated = await writeFact(ctx, s, "Deploy cadence", "we ship the app every thursday");
    expect(unrelated.similar_existing).toBeUndefined();
    expect(unrelated.reconcile).toBeUndefined();
    expect(judge.calls).toBe(0);
  });

  it("decays a non-noop verdict that names an unknown target to noop", async () => {
    const judge = new FakeJudge(() => ({
      action: "supersede",
      target_id: "01NOTACANDIDATE",
      reason: "hallucinated target",
    }));
    const { ctx, worker } = makeCtx({ consolidator: judge });
    const s = await session(ctx, P);
    await writeFact(ctx, s, "Token TTL", ORIGINAL);
    await worker.tick();

    const dup = await writeFact(ctx, s, "Token TTL", ORIGINAL);
    expect(dup.reconcile).toEqual({
      action: "noop",
      target_id: null,
      reason: "hallucinated target",
    });
  });

  it("is disabled by MEMORY_CONSOLIDATE_RECONCILE=off (advisory hint still fires)", async () => {
    process.env.MEMORY_CONSOLIDATE_RECONCILE = "off";
    const judge = new FakeJudge((t) => ({
      action: "update",
      target_id: t.candidates[0]!.id,
      reason: "x",
    }));
    const { ctx, worker } = makeCtx({ consolidator: judge });
    const s = await session(ctx, P);
    const original = await writeFact(ctx, s, "Token TTL", ORIGINAL);
    await worker.tick();

    const dup = await writeFact(ctx, s, "Token TTL", ORIGINAL);
    expect(dup.similar_existing?.[0]?.id).toBe(original.id); // probe unaffected
    expect(dup.reconcile).toBeUndefined();
    expect(judge.calls).toBe(0);
  });

  it("never fires under the default offline (manual) provider", async () => {
    const { ctx, worker } = makeCtx(); // default manual consolidator, enabled=false
    const s = await session(ctx, P);
    await writeFact(ctx, s, "Token TTL", ORIGINAL);
    await worker.tick();

    const dup = await writeFact(ctx, s, "Token TTL", ORIGINAL);
    expect(dup.similar_existing).toBeDefined();
    expect(dup.reconcile).toBeUndefined();
  });

  it("survives a provider failure — the write still succeeds without reconcile", async () => {
    const boom: ConsolidationProvider = {
      name: "boom",
      version: "1",
      enabled: true,
      generate: () => Promise.reject(new Error("no")),
      reconcile: () => Promise.reject(new Error("provider down")),
    };
    const { ctx, worker } = makeCtx({ consolidator: boom });
    const s = await session(ctx, P);
    const original = await writeFact(ctx, s, "Token TTL", ORIGINAL);
    await worker.tick();

    const dup = await writeFact(ctx, s, "Token TTL", ORIGINAL);
    expect(dup.id).toBeDefined();
    expect(dup.similar_existing?.[0]?.id).toBe(original.id);
    expect(dup.reconcile).toBeUndefined();
  });
});
