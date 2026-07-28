import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import type { MirrorSourceStatus } from "@/core/types";
import { EdgeType, MemoryKind } from "@/core/vocab";
import { GetTool } from "@/tools/get";
import { InvalidateTool } from "@/tools/invalidate";
import { LinkTool } from "@/tools/link";
import { MirrorStatusTool } from "@/tools/mirror-status";
import { MirrorUpsertTool } from "@/tools/mirror-upsert";
import { SearchTool } from "@/tools/search";
import { SessionStartTool } from "@/tools/session-start";
import { SourceRegisterTool } from "@/tools/source-register";
import { WriteTool } from "@/tools/write";
import { setup } from "@test/helpers";

function tools() {
  return {
    sessionStart: container.resolve(SessionStartTool),
    sourceRegister: container.resolve(SourceRegisterTool),
    mirrorUpsert: container.resolve(MirrorUpsertTool),
    mirrorStatus: container.resolve(MirrorStatusTool),
    get: container.resolve(GetTool),
    invalidate: container.resolve(InvalidateTool),
    write: container.resolve(WriteTool),
    link: container.resolve(LinkTool),
    search: container.resolve(SearchTool),
  };
}

async function boot(opts?: Parameters<typeof setup>[0]) {
  const env = setup(opts);
  const t = tools();
  const s = await t.sessionStart.invoke({ project: "acme" });
  return { env, t, sid: s.session_id };
}

const INCIDENT = {
  native_id: "INC-42",
  type: "incident",
  title: "Checkout latency spike",
  content: "p99 checkout latency crossed 2s for 12 minutes; rolled back deploy #918.",
  url: "https://grafana/incident/42",
  facets: { severity: "sev2" },
};

function registerGrafana(t: ReturnType<typeof tools>, sid: string) {
  return t.sourceRegister.invoke({
    id: "grafana-prod",
    kind: "grafana",
    label: "Grafana (prod)",
    project: "acme",
    freshness_hours: 24,
    session_id: sid,
  });
}

describe("SourceRegisterTool + MirrorStatusTool", () => {
  it("should report no sources and emit no stale_sources when the registry is empty", async () => {
    // Given
    const { t, sid } = await boot();

    // When
    const st = (await t.mirrorStatus.invoke({ session_id: sid })) as { sources: unknown[] };

    // Then
    expect(st.sources).toEqual([]);
    const s = await t.sessionStart.invoke({ project: "acme" });
    expect(s.working_set).not.toHaveProperty("stale_sources");
  });

  it("should report a registered source as stale when it has not been synced yet", async () => {
    // Given
    const { t, sid } = await boot();

    // When
    await registerGrafana(t, sid);

    // Then
    const st = (await t.mirrorStatus.invoke({ session_id: sid })) as {
      sources: MirrorSourceStatus[];
    };
    expect(st.sources).toHaveLength(1);
    expect(st.sources[0]).toMatchObject({ id: "grafana-prod", stale: true, node_count: 0 });
  });
});

describe("MirrorUpsertTool", () => {
  it("should throw an actionable error when the source is not registered", async () => {
    // Given
    const { t, sid } = await boot();

    // When / Then
    await expect(
      t.mirrorUpsert.invoke({ session_id: sid, source_id: "nope", items: [INCIDENT] }),
    ).rejects.toThrow(/source_register/);
  });

  it("should mirror a curated record so get returns url + facets and search scopes to it when upserted", async () => {
    // Given
    const { t, sid } = await boot();
    await registerGrafana(t, sid);

    // When
    const r = (await t.mirrorUpsert.invoke({
      session_id: sid,
      source_id: "grafana-prod",
      items: [INCIDENT],
    })) as { added: number; node_ids: string[] };

    // Then
    expect(r.added).toBe(1);
    const id = r.node_ids[0];

    const g = (await t.get.invoke({ session_id: sid, ids: [id!] })) as {
      nodes: { url?: string; facets?: unknown; mirror?: { source_id: string } }[];
    };
    expect(g.nodes[0]!.url).toBe(INCIDENT.url);
    expect(g.nodes[0]!.facets).toEqual(INCIDENT.facets);
    expect(g.nodes[0]!.mirror?.source_id).toBe("grafana-prod");

    const found = (await t.search.invoke({
      session_id: sid,
      query: "checkout latency",
      limit: 10,
      kinds: [MemoryKind.MIRROR],
      types: ["incident"],
    })) as { results: { id: string }[] };
    expect(found.results.some((x) => x.id === id)).toBe(true);
  });

  it("should move the source out of staleness when a record is synced", async () => {
    // Given
    const { t, sid } = await boot();
    await registerGrafana(t, sid);

    // When
    await t.mirrorUpsert.invoke({ session_id: sid, source_id: "grafana-prod", items: [INCIDENT] });

    // Then
    const st = (await t.mirrorStatus.invoke({ session_id: sid })) as {
      sources: MirrorSourceStatus[];
    };
    expect(st.sources[0]).toMatchObject({ stale: false, node_count: 1 });
  });
});

describe("Invalidate guard + session_start freshness", () => {
  it("should let the agent retire an external mirror record when invalidated by hand", async () => {
    // Given
    const { t, sid } = await boot();
    await registerGrafana(t, sid);
    const r = (await t.mirrorUpsert.invoke({
      session_id: sid,
      source_id: "grafana-prod",
      items: [INCIDENT],
    })) as { node_ids: string[] };

    // When
    const env = (await t.invalidate.invoke({
      session_id: sid,
      id: r.node_ids[0]!,
      reason: "incident resolved and archived",
    })) as { invalidated: boolean };

    // Then
    expect(env.invalidated).toBe(true);
  });

  it("should surface stale sources in session_start when the freshness window has passed", async () => {
    // Given
    const { env, t, sid } = await boot();
    await registerGrafana(t, sid);
    await t.mirrorUpsert.invoke({ session_id: sid, source_id: "grafana-prod", items: [INCIDENT] });

    // When
    env.clock.advanceMs(25 * 3_600_000);
    const s = await t.sessionStart.invoke({ project: "acme" });

    // Then
    const ws = s.working_set as { stale_sources?: { id: string }[] };
    expect(ws.stale_sources?.some((x) => x.id === "grafana-prod")).toBe(true);
  });
});

describe("Link payoff: a note documents a mirror record", () => {
  it("should surface the mirror via graph expansion when a decision draws a documents edge to it", async () => {
    // Given
    const { env, t, sid } = await boot();
    await registerGrafana(t, sid);
    const r = (await t.mirrorUpsert.invoke({
      session_id: sid,
      source_id: "grafana-prod",
      items: [INCIDENT],
    })) as { node_ids: string[] };
    const mirrorId = r.node_ids[0];

    const decision = (await t.write.invoke({
      session_id: sid,
      memory_kind: MemoryKind.SEMANTIC,
      type: "decision",
      title: "Add cache jitter to prevent stampede",
      content: "We added jitter to cache TTLs after the checkout latency incident.",
      project: "acme",
    })) as { id: string };

    // When
    await t.link.invoke({
      session_id: sid,
      src: decision.id,
      dst: mirrorId!,
      type: EdgeType.DOCUMENTS,
    });

    // Drain embeddings so hybrid/graph expansion is fully exercised.
    for (let i = 0; i < 20; i++) {
      const res = await env.worker.tick();
      if (res.embedded === 0 && res.failed === 0) break;
    }

    // Then
    const found = (await t.search.invoke({
      session_id: sid,
      query: "cache jitter stampede",
      limit: 10,
    })) as { results: { id: string; via?: { edge: string } }[] };
    expect(found.results.some((x) => x.id === mirrorId)).toBe(true);
  });
});
