import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { RerankProvider } from "@/domain/ports/rerank-provider";
import type { Envelope } from "@/db/repo";
import { LocalNullReranker } from "@/rerank/local-null";
import { EdgeType, MemoryKind } from "@/core/vocab";
import { LinkTool } from "@/presentation/mcp/tools/link";
import { SearchTool } from "@/presentation/mcp/tools/search";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup } from "@test/helpers";

async function session(project?: string): Promise<string> {
  return (await container.resolve(SessionStartTool).invoke({ project })).session_id;
}
function w(
  s: string,
  kind: MemoryKind,
  type: string,
  title: string,
  content: string,
): Promise<Envelope> {
  return container
    .resolve(WriteTool)
    .invoke({ session_id: s, memory_kind: kind, type, title, content });
}
type Result = Envelope & { matched: string; via?: { node: string; edge: string } };
function ids(res: unknown): string[] {
  return (res as { results: Result[] }).results.map((r) => r.id);
}
function searchIds(args: Parameters<SearchTool["invoke"]>[0]): Promise<string[]> {
  return container.resolve(SearchTool).invoke(args).then(ids);
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

describe("Rerank stage", () => {
  it("should reorder the fused base hits, overriding the RRF order, when a reranker is enabled", async () => {
    const query = "kafka pipeline";
    const strong = "kafka pipeline kafka pipeline kafka pipeline"; // higher bm25
    const weak = "kafka pipeline zzqmarker widget"; // lower bm25, carries the marker

    // Given — reranker off (default): RRF orders by bm25.
    setup();
    const sOff = await session();
    const strongOff = await w(sOff, MemoryKind.SEMANTIC, "fact", "Strong", strong);
    const weakOff = await w(sOff, MemoryKind.SEMANTIC, "fact", "Weak", weak);
    const baseline = await searchIds({ session_id: sOff, query, limit: 10 });
    expect(baseline).toEqual([strongOff.id, weakOff.id]);

    // When / Then — reranker promotes the marked doc.
    setup({ reranker: new MarkerReranker("zzqmarker") });
    const sOn = await session();
    const strongOn = await w(sOn, MemoryKind.SEMANTIC, "fact", "Strong", strong);
    const weakOn = await w(sOn, MemoryKind.SEMANTIC, "fact", "Weak", weak);
    const reranked = await searchIds({ session_id: sOn, query, limit: 10 });
    expect(reranked).toEqual([weakOn.id, strongOn.id]);
  });

  it("should not rerank graph-expanded neighbors", async () => {
    // Given — two base hits (so the rerank stage runs) plus a graph-only neighbor.
    setup({ reranker: new LocalNullReranker() });
    const s = await session();
    const howto = await w(
      s,
      MemoryKind.SEMANTIC,
      "howto",
      "Deploy billing",
      "how to deploy the billing pipeline runbook steps",
    );
    await w(s, MemoryKind.SEMANTIC, "howto", "Deploy notes", "deploy pipeline release notes");
    const entity = await w(
      s,
      MemoryKind.SEMANTIC,
      "entity",
      "PaymentService",
      "PaymentService internal component details",
    );
    await container
      .resolve(LinkTool)
      .invoke({ session_id: s, src: howto.id, dst: entity.id, type: EdgeType.DOCUMENTS });

    // When
    const res = (await container
      .resolve(SearchTool)
      .invoke({ session_id: s, query: "billing pipeline deploy", limit: 10 })) as unknown as {
      results: Result[];
    };

    // Then — still a neighbor, not rescored as a base hit.
    const surfaced = res.results.find((r) => r.id === entity.id);
    expect(surfaced).toBeDefined();
    expect(surfaced!.matched).toBe("graph");
    expect(surfaced!.via).toEqual({ node: howto.id, edge: "documents" });
  });

  it("should keep episodic decay as a post-rerank multiplier", async () => {
    // Given
    const env = setup({ reranker: new LocalNullReranker() });
    const s = await session();
    const content = "deploy the release pipeline"; // identical -> equal rerank relevance
    const old = await w(s, MemoryKind.EPISODIC, "event_note", "Deploy", content);
    env.clock.advanceDays(59);
    const fresh = await w(s, MemoryKind.EPISODIC, "event_note", "Deploy", content);
    env.clock.advanceDays(1);
    const fact = await w(s, MemoryKind.SEMANTIC, "fact", "Deploy", content);
    await env.worker.tick();

    // When
    const res = await searchIds({ session_id: s, query: "deploy pipeline", limit: 10 });

    // Then — decay still orders the ties.
    expect(res).toEqual([fact.id, fresh.id, old.id]);
  });

  it("should fall back to the RRF order when the reranker throws", async () => {
    const query = "kafka pipeline";
    const strong = "kafka pipeline kafka pipeline kafka pipeline";
    const weak = "kafka pipeline widget";

    // Given — baseline with reranker off.
    setup();
    const sOff = await session();
    const a = await w(sOff, MemoryKind.SEMANTIC, "fact", "Strong", strong);
    const b = await w(sOff, MemoryKind.SEMANTIC, "fact", "Weak", weak);
    const baseline = await searchIds({ session_id: sOff, query, limit: 10 });

    // When — a throwing reranker degrades gracefully.
    setup({ reranker: new BrokenReranker() });
    const sBroken = await session();
    const a2 = await w(sBroken, MemoryKind.SEMANTIC, "fact", "Strong", strong);
    const b2 = await w(sBroken, MemoryKind.SEMANTIC, "fact", "Weak", weak);
    const degraded = await searchIds({ session_id: sBroken, query, limit: 10 });

    // Then — order unchanged despite the throw.
    expect(baseline).toEqual([a.id, b.id]);
    expect(degraded).toEqual([a2.id, b2.id]);
  });
});

describe("Rerank usage in stats", () => {
  // Rerank telemetry is derived from search `events` rows; event logging is deferred
  // until the DI logger lands, so this stays skipped until then.
  it.skip("should count eligible searches, reranked searches, and candidates scored", () => {
    // pending: event logging (custom DI logger) — see search tool TODO.
  });
});
