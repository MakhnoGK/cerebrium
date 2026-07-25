import { describe, it, expect } from "vitest";
import { makeCtx } from "@test/helpers";
import type { TestCtx } from "@test/helpers";
import type { MirrorSourceStatus } from "@/core/types";
import { SessionStartTool } from "../src/tools/session_start";
import { SourceRegisterTool } from "../src/tools/source_register";
import { MirrorUpsertTool } from "../src/tools/mirror_upsert";
import { MirrorStatusTool } from "../src/tools/mirror_status";
import { GetTool } from "../src/tools/get";
import { InvalidateTool } from "../src/tools/invalidate";
import { WriteTool } from "../src/tools/write";
import { LinkTool } from "../src/tools/link";
import { SearchTool } from "../src/tools/search";

const session_start = new SessionStartTool();
const source_register = new SourceRegisterTool();
const mirror_upsert = new MirrorUpsertTool();
const mirror_status = new MirrorStatusTool();
const get = new GetTool();
const invalidate = new InvalidateTool();
const write = new WriteTool();
const link = new LinkTool();
const search = new SearchTool();

async function boot(opts?: Parameters<typeof makeCtx>[0]): Promise<TestCtx & { sid: string }> {
  const t = makeCtx(opts);
  const s = await session_start.invoke(t.ctx, { project: "acme" });
  return { ...t, sid: s.session_id };
}

const INCIDENT = {
  native_id: "INC-42",
  type: "incident",
  title: "Checkout latency spike",
  content: "p99 checkout latency crossed 2s for 12 minutes; rolled back deploy #918.",
  url: "https://grafana/incident/42",
  facets: { severity: "sev2" },
};

async function registerGrafana(ctx: TestCtx["ctx"], sid: string) {
  return source_register.invoke(ctx, {
    id: "grafana-prod",
    kind: "grafana",
    label: "Grafana (prod)",
    project: "acme",
    freshness_hours: 24,
    session_id: sid,
  });
}

describe("source_register + mirror_status", () => {
  it("is empty by default: no sources, session_start emits no stale_sources", async () => {
    const { ctx, sid } = await boot();
    const st = (await mirror_status.invoke(ctx, { session_id: sid })) as { sources: unknown[] };
    expect(st.sources).toEqual([]);
    const s = await session_start.invoke(ctx, { project: "acme" });
    expect(s.working_set).not.toHaveProperty("stale_sources");
  });

  it("registers a source and reports it as stale until first sync", async () => {
    const { ctx, sid } = await boot();
    await registerGrafana(ctx, sid);
    const st = (await mirror_status.invoke(ctx, { session_id: sid })) as {
      sources: MirrorSourceStatus[];
    };
    expect(st.sources).toHaveLength(1);
    expect(st.sources[0]).toMatchObject({ id: "grafana-prod", stale: true, node_count: 0 });
  });
});

describe("mirror_upsert", () => {
  it("errors actionably for an unregistered source", async () => {
    const { ctx, sid } = await boot();
    await expect(
      mirror_upsert.invoke(ctx, { session_id: sid, source_id: "nope", items: [INCIDENT] }),
    ).rejects.toThrow(/source_register/);
  });

  it("mirrors a curated record; get returns url + facets; search scopes to it", async () => {
    const { ctx, sid } = await boot();
    await registerGrafana(ctx, sid);
    const r = (await mirror_upsert.invoke(ctx, {
      session_id: sid,
      source_id: "grafana-prod",
      items: [INCIDENT],
    })) as { added: number; node_ids: string[] };
    expect(r.added).toBe(1);
    const id = r.node_ids[0];

    const g = (await get.invoke(ctx, { session_id: sid, ids: [id] })) as {
      nodes: { url?: string; facets?: unknown; mirror?: { source_id: string } }[];
    };
    expect(g.nodes[0].url).toBe(INCIDENT.url);
    expect(g.nodes[0].facets).toEqual(INCIDENT.facets);
    expect(g.nodes[0].mirror?.source_id).toBe("grafana-prod");

    const found = (await search.invoke(ctx, {
      session_id: sid,
      query: "checkout latency",
      kinds: ["mirror"],
      types: ["incident"],
    })) as { results: { id: string }[] };
    expect(found.results.some((x) => x.id === id)).toBe(true);
  });

  it("bumps the source out of staleness after a sync", async () => {
    const { ctx, sid } = await boot();
    await registerGrafana(ctx, sid);
    await mirror_upsert.invoke(ctx, {
      session_id: sid,
      source_id: "grafana-prod",
      items: [INCIDENT],
    });
    const st = (await mirror_status.invoke(ctx, { session_id: sid })) as {
      sources: MirrorSourceStatus[];
    };
    expect(st.sources[0]).toMatchObject({ stale: false, node_count: 1 });
  });
});

describe("invalidate guard + session_start freshness", () => {
  it("lets the agent retire an external mirror record", async () => {
    const { ctx, sid } = await boot();
    await registerGrafana(ctx, sid);
    const r = (await mirror_upsert.invoke(ctx, {
      session_id: sid,
      source_id: "grafana-prod",
      items: [INCIDENT],
    })) as { node_ids: string[] };
    const env = (await invalidate.invoke(ctx, {
      session_id: sid,
      id: r.node_ids[0],
      reason: "incident resolved and archived",
    })) as { invalidated: boolean };
    expect(env.invalidated).toBe(true);
  });

  it("surfaces stale sources in session_start after the freshness window passes", async () => {
    const { ctx, sid, clock } = await boot();
    await registerGrafana(ctx, sid);
    await mirror_upsert.invoke(ctx, {
      session_id: sid,
      source_id: "grafana-prod",
      items: [INCIDENT],
    });

    clock.advanceMs(25 * 3_600_000);
    const s = await session_start.invoke(ctx, { project: "acme" });
    const ws = s.working_set as { stale_sources?: { id: string }[] };
    expect(ws.stale_sources?.some((x) => x.id === "grafana-prod")).toBe(true);
  });
});

describe("link payoff: note documents a mirror record", () => {
  it("a decision -> mirror `documents` edge surfaces the mirror via graph expansion", async () => {
    const { ctx, sid, worker } = await boot();
    await registerGrafana(ctx, sid);
    const r = (await mirror_upsert.invoke(ctx, {
      session_id: sid,
      source_id: "grafana-prod",
      items: [INCIDENT],
    })) as { node_ids: string[] };
    const mirrorId = r.node_ids[0];

    const decision = (await write.invoke(ctx, {
      session_id: sid,
      memory_kind: "semantic",
      type: "decision",
      title: "Add cache jitter to prevent stampede",
      content: "We added jitter to cache TTLs after the checkout latency incident.",
      project: "acme",
    })) as { id: string };

    await link.invoke(ctx, {
      session_id: sid,
      src: decision.id,
      dst: mirrorId,
      type: "documents",
    });

    // Drain embeddings so hybrid/graph expansion is fully exercised.
    for (let i = 0; i < 20; i++) {
      const res = await worker.tick();
      if (res.embedded === 0 && res.failed === 0) break;
    }

    const found = (await search.invoke(ctx, {
      session_id: sid,
      query: "cache jitter stampede",
    })) as { results: { id: string; via?: { edge: string } }[] };
    expect(found.results.some((x) => x.id === mirrorId)).toBe(true);
  });
});
