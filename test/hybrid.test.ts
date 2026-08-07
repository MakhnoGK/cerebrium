import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import type { Envelope } from "@/db/repo";
import { EdgeType, MemoryKind } from "@/core/vocab";
import { InvalidateTool } from "@/presentation/mcp/tools/invalidate";
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
  project?: string,
): Promise<Envelope> {
  return container
    .resolve(WriteTool)
    .invoke({ session_id: s, memory_kind: kind, type, title, content, project });
}

type Result = Envelope & {
  matched: string;
  best_chunk?: string;
  via?: { node: string; edge: string };
};

function results(res: unknown): Result[] {
  return (res as { results: Result[] }).results;
}

function search(args: Parameters<SearchTool["invoke"]>[0]) {
  return container.resolve(SearchTool).invoke(args);
}

describe("RRF fusion", () => {
  it("should outrank a single-branch node with one matched by both branches", async () => {
    // Given
    const env = setup();
    const s = await session();
    const body = "reciprocal rank fusion ranking algorithm for retrieval";
    const both = await w(s, MemoryKind.SEMANTIC, "fact", "Alpha", body);
    await env.worker.tick(); // embed Alpha -> it lands in the vector branch too
    const textOnly = await w(s, MemoryKind.SEMANTIC, "fact", "Beta", body); // not drained -> FTS only

    // When
    const res = results(
      await search({ session_id: s, query: "reciprocal rank fusion", limit: 10 }),
    );

    // Then
    const alpha = res.find((r) => r.id === both.id)!;
    const beta = res.find((r) => r.id === textOnly.id)!;
    expect(alpha.matched).toBe("both");
    expect(beta.matched).toBe("text");
    expect(res.findIndex((r) => r.id === both.id)).toBeLessThan(
      res.findIndex((r) => r.id === textOnly.id),
    );
  });
});

describe("Memory-model factors hold in hybrid mode", () => {
  it("should rank semantic above fresh episodic above old episodic with vectors present", async () => {
    // Given
    const env = setup();
    const s = await session();
    const content = "deploy the release pipeline";
    const old = await w(s, MemoryKind.EPISODIC, "event_note", "Deploy", content);
    env.clock.advanceDays(59);
    const fresh = await w(s, MemoryKind.EPISODIC, "event_note", "Deploy", content);
    env.clock.advanceDays(1);
    const fact = await w(s, MemoryKind.SEMANTIC, "fact", "Deploy", content);
    await env.worker.tick(); // embed all three -> vector branch active

    // When
    const res = results(await search({ session_id: s, query: "deploy pipeline", limit: 10 }));

    // Then
    expect(res.map((r) => r.id)).toEqual([fact.id, fresh.id, old.id]);
  });

  it("should exclude superseded nodes from normal search and from graph expansion", async () => {
    // Given
    const env = setup();
    const s = await session();
    const oldNode = await w(
      s,
      MemoryKind.SEMANTIC,
      "fact",
      "Old TTL",
      "access tokens live 15 minutes",
    );
    const newNode = await w(
      s,
      MemoryKind.SEMANTIC,
      "fact",
      "New TTL",
      "access tokens live 10 minutes",
    );
    await env.worker.tick();
    await container.resolve(InvalidateTool).invoke({
      session_id: s,
      id: oldNode.id,
      reason: "shortened",
      superseded_by: newNode.id,
    });

    // When
    const normal = results(
      await search({ session_id: s, query: "access tokens live minutes", limit: 10 }),
    );

    // Then
    expect(normal.some((r) => r.id === oldNode.id)).toBe(false); // hidden
    expect(normal.some((r) => r.id === newNode.id)).toBe(true);

    // When / Then — visible under history, flagged, never via graph expansion.
    const hist = await search({
      session_id: s,
      query: "access tokens live minutes",
      history: true,
      limit: 10,
    });
    const histRows = results(hist);
    const oldHit = histRows.find((r) => r.id === oldNode.id);
    expect(oldHit?.invalidated).toBe(true);
    expect(histRows.every((r) => !(r.id === oldNode.id && r.matched === "graph"))).toBe(true);

    const notes = (hist as { context_notes?: string[] }).context_notes ?? [];
    expect(notes.some((n) => n.includes(oldNode.id) && n.includes(newNode.id))).toBe(true);
  });
});

describe("Graph expansion", () => {
  it("should surface a documents-linked neighbor with a correct via edge", async () => {
    // Given — neither embedded (no tick): FTS finds the how-to, graph pulls in the entity.
    setup();
    const s = await session();
    const howto = await w(
      s,
      MemoryKind.SEMANTIC,
      "howto",
      "Deploy billing",
      "how to deploy the billing pipeline runbook steps",
    );
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
    const res = results(
      await search({ session_id: s, query: "billing pipeline deploy", limit: 10 }),
    );

    // Then
    const surfaced = res.find((r) => r.id === entity.id);
    expect(surfaced).toBeDefined();
    expect(surfaced!.matched).toBe("graph");
    expect(surfaced!.via).toEqual({ node: howto.id, edge: "documents" });
  });
});

describe("Search mode variants", () => {
  it("should find a node under mode:'vector' only after it is embedded, with a best_chunk", async () => {
    // Given
    const env = setup();
    const s = await session();
    const node = await w(
      s,
      MemoryKind.SEMANTIC,
      "fact",
      "Kafka",
      "the ingestion service consumes from kafka topics",
    );

    // When / Then — not embedded yet.
    const before = results(
      await search({ session_id: s, query: "kafka ingestion", mode: "vector", limit: 10 }),
    );
    expect(before.some((r) => r.id === node.id)).toBe(false);

    // When / Then — after embedding.
    await env.worker.tick();
    const after = results(
      await search({ session_id: s, query: "kafka ingestion", mode: "vector", limit: 10 }),
    );
    const hit = after.find((r) => r.id === node.id)!;
    expect(hit.matched).toBe("vector");
    expect(typeof hit.best_chunk).toBe("string");
    expect(hit.best_chunk!.length).toBeGreaterThan(0);
  });

  it("should return envelopes only with no hybrid-only fields under mode:'text'", async () => {
    // Given
    const env = setup();
    const s = await session();
    await w(s, MemoryKind.SEMANTIC, "fact", "Alpha", "alpha beta gamma");
    await env.worker.tick();

    // When
    const res = await search({ session_id: s, query: "alpha", mode: "text", limit: 10 });

    // Then
    expect(Object.keys(res).sort()).toEqual(["results", "total_matches"]);
    expect(res.context_notes).toBeUndefined();
    const envRow = (res.results as unknown as Record<string, unknown>[])[0]!;
    expect(Object.keys(envRow).sort()).toEqual([
      "best_chunk",
      "edges",
      "id",
      "invalidated",
      "kind",
      "project",
      "rev",
      "title",
      "type",
      "updated",
    ]);
  });
});
