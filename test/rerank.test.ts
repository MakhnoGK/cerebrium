import { describe, it, expect } from "vitest";
import { makeCtx } from "./helpers";
import { LocalNullReranker } from "@/rerank/local-null";
import type { RerankProvider } from "@/rerank/index";
import type { Ctx } from "@/tools/context";
import type { Envelope } from "@/db/repo";
import { SessionStartTool } from "../src/tools/session_start";
import { WriteTool } from "../src/tools/write";
import { LinkTool } from "../src/tools/link";
import { SearchTool } from "../src/tools/search";

const session_start = new SessionStartTool();
const write = new WriteTool();
const link = new LinkTool();
const search = new SearchTool();

async function session(ctx: Ctx, project?: string): Promise<string> {
  return (await session_start.invoke(ctx, { project })).session_id;
}
function w(
  ctx: Ctx,
  s: string,
  kind: "semantic" | "episodic",
  type: string,
  title: string,
  content: string,
) {
  return write.invoke(ctx, {
    session_id: s,
    memory_kind: kind,
    type,
    title,
    content,
  }) as Promise<unknown> as Promise<Envelope>;
}
type Result = Envelope & { matched: string; via?: { node: string; edge: string } };
function ids(res: unknown): string[] {
  return (res as { results: Result[] }).results.map((r) => r.id);
}

// A reranker whose score is fully controlled by a text marker — lets a test force a
// specific order and prove the stage actually reorders.
class MarkerReranker implements RerankProvider {
  readonly name = "marker";
  readonly version = "1";
  readonly enabled = true;
  constructor(private readonly marker: string) {}
  async rerank(_query: string, docs: string[]): Promise<number[]> {
    return docs.map((d) => (d.includes(this.marker) ? 1 : 0));
  }
}

class BrokenReranker implements RerankProvider {
  readonly name = "broken";
  readonly version = "1";
  readonly enabled = true;
  async rerank(): Promise<number[]> {
    throw new Error("model unavailable");
  }
}

describe("rerank stage", () => {
  it("reorders the fused base hits (overriding the RRF order)", async () => {
    const query = "kafka pipeline";
    const strong = "kafka pipeline kafka pipeline kafka pipeline"; // higher bm25
    const weak = "kafka pipeline zzqmarker widget"; // lower bm25, carries the marker

    const off = makeCtx();
    const sOff = await session(off.ctx);
    const strongOff = await w(off.ctx, sOff, "semantic", "fact", "Strong", strong);
    const weakOff = await w(off.ctx, sOff, "semantic", "fact", "Weak", weak);
    const baseline = ids(await search.invoke(off.ctx, { session_id: sOff, query, limit: 10 }));
    expect(baseline).toEqual([strongOff.id, weakOff.id]); // RRF: stronger bm25 first

    const on = makeCtx({ reranker: new MarkerReranker("zzqmarker") });
    const sOn = await session(on.ctx);
    const strongOn = await w(on.ctx, sOn, "semantic", "fact", "Strong", strong);
    const weakOn = await w(on.ctx, sOn, "semantic", "fact", "Weak", weak);
    const reranked = ids(await search.invoke(on.ctx, { session_id: sOn, query, limit: 10 }));
    expect(reranked).toEqual([weakOn.id, strongOn.id]); // reranker promotes the marked doc
  });

  it("does not rerank graph-expanded neighbors", async () => {
    const { ctx } = makeCtx({ reranker: new LocalNullReranker() });
    const s = await session(ctx);
    // Two base hits (so the rerank stage runs) plus a graph-only neighbor.
    const howto = await w(
      ctx,
      s,
      "semantic",
      "howto",
      "Deploy billing",
      "how to deploy the billing pipeline runbook steps",
    );
    await w(ctx, s, "semantic", "howto", "Deploy notes", "deploy pipeline release notes");
    const entity = await w(
      ctx,
      s,
      "semantic",
      "entity",
      "PaymentService",
      "PaymentService internal component details",
    );
    await link.invoke(ctx, { session_id: s, src: howto.id, dst: entity.id, type: "documents" });

    const res = (await search.invoke(ctx, {
      session_id: s,
      query: "billing pipeline deploy",
      limit: 10,
    })) as {
      results: Result[];
    };
    const surfaced = res.results.find((r) => r.id === entity.id);
    expect(surfaced).toBeDefined();
    expect(surfaced!.matched).toBe("graph"); // still a neighbor, not rescored as a base hit
    expect(surfaced!.via).toEqual({ node: howto.id, edge: "documents" });
  });

  it("keeps episodic decay as a post-rerank multiplier", async () => {
    const { ctx, clock, worker } = makeCtx({ reranker: new LocalNullReranker() });
    const s = await session(ctx);
    const content = "deploy the release pipeline"; // identical -> equal rerank relevance
    const old = await w(ctx, s, "episodic", "event_note", "Deploy", content);
    clock.advanceDays(59);
    const fresh = await w(ctx, s, "episodic", "event_note", "Deploy", content);
    clock.advanceDays(1);
    const fact = await w(ctx, s, "semantic", "fact", "Deploy", content);
    await worker.tick();

    const res = ids(
      await search.invoke(ctx, { session_id: s, query: "deploy pipeline", limit: 10 }),
    );
    expect(res).toEqual([fact.id, fresh.id, old.id]); // decay still orders the ties
  });

  it("falls back to RRF order when the reranker throws", async () => {
    const query = "kafka pipeline";
    const strong = "kafka pipeline kafka pipeline kafka pipeline";
    const weak = "kafka pipeline widget";

    const off = makeCtx();
    const sOff = await session(off.ctx);
    const a = await w(off.ctx, sOff, "semantic", "fact", "Strong", strong);
    const b = await w(off.ctx, sOff, "semantic", "fact", "Weak", weak);
    const baseline = ids(await search.invoke(off.ctx, { session_id: sOff, query, limit: 10 }));

    const broken = makeCtx({ reranker: new BrokenReranker() });
    const sBroken = await session(broken.ctx);
    const a2 = await w(broken.ctx, sBroken, "semantic", "fact", "Strong", strong);
    const b2 = await w(broken.ctx, sBroken, "semantic", "fact", "Weak", weak);
    const degraded = ids(
      await search.invoke(broken.ctx, { session_id: sBroken, query, limit: 10 }),
    );

    expect(baseline).toEqual([a.id, b.id]);
    expect(degraded).toEqual([a2.id, b2.id]); // unchanged despite the throw
  });
});

describe("rerank usage in stats", () => {
  it("counts eligible searches, reranked searches, and candidates scored", async () => {
    const { ctx, repo, clock } = makeCtx({ reranker: new LocalNullReranker() });
    const s = await session(ctx);
    await w(ctx, s, "semantic", "fact", "One", "alpha beta");
    await w(ctx, s, "semantic", "fact", "Two", "alpha gamma");
    await w(ctx, s, "semantic", "fact", "Three", "delta unique");

    await search.invoke(ctx, { session_id: s, query: "alpha", limit: 10 }); // 2 candidates -> reranked
    await search.invoke(ctx, { session_id: s, query: "alpha", mode: "text", limit: 10 }); // not eligible
    await search.invoke(ctx, { session_id: s, query: "delta", limit: 10 }); // 1 candidate -> eligible, not reranked

    const u = repo.techStats(clock.t).rerank_usage;
    expect(u.eligible_searches).toBe(2);
    expect(u.reranked_searches).toBe(1);
    expect(u.candidates_reranked).toBe(2);
  });
});
