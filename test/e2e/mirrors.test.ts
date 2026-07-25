import { describe, it, expect } from "vitest";
import { makeCtx } from "../helpers";
import { SessionStartTool } from "../../src/tools/session_start";
import { SourceRegisterTool } from "../../src/tools/source_register";
import { MirrorUpsertTool } from "../../src/tools/mirror_upsert";
import { WriteTool } from "../../src/tools/write";
import { LinkTool } from "../../src/tools/link";
import { SearchTool } from "../../src/tools/search";

const P = "acme";

// Phase 3a §9.4: register two sources → mirror a Grafana incident + a Sentry issue →
// relate them → document the incident with a decision → search surfaces the incident and
// expands to its neighbors → the source goes stale after its window and clears on re-sync.
describe("external mirrors — end-to-end", () => {
  const session_start = new SessionStartTool();
  const source_register = new SourceRegisterTool();
  const mirror_upsert = new MirrorUpsertTool();
  const write = new WriteTool();
  const link = new LinkTool();
  const search = new SearchTool();

  it("mirrors, links, surfaces via graph expansion, and tracks freshness", async () => {
    const { ctx, clock, worker } = makeCtx();
    const sid = ((await session_start.invoke(ctx, { project: P })) as any).session_id;

    await source_register.invoke(ctx, {
      session_id: sid,
      id: "grafana-prod",
      kind: "grafana",
      label: "Grafana (prod)",
      project: P,
      freshness_hours: 24,
    });
    await source_register.invoke(ctx, {
      session_id: sid,
      id: "sentry",
      kind: "sentry",
      project: P,
      freshness_hours: 24,
    });

    const inc = (await mirror_upsert.invoke(ctx, {
      session_id: sid,
      source_id: "grafana-prod",
      items: [
        {
          native_id: "INC-42",
          type: "incident",
          title: "Checkout latency spike",
          content: "p99 checkout latency crossed 2s for 12 minutes; rolled back deploy #918.",
          url: "https://grafana/incident/42",
          facets: { severity: "sev2", service: "checkout" },
        },
      ],
    })) as { node_ids: string[] };
    const incidentId = inc.node_ids[0];

    const iss = (await mirror_upsert.invoke(ctx, {
      session_id: sid,
      source_id: "sentry",
      items: [
        {
          native_id: "PROJ-9K",
          type: "issue",
          title: "TimeoutError in CheckoutController",
          content: "Spike of TimeoutError from the checkout cache client during the incident.",
          url: "https://sentry/issues/9k",
        },
      ],
    })) as { node_ids: string[] };
    const issueId = iss.node_ids[0];

    // Relate the two mirror records across sources.
    await link.invoke(ctx, {
      session_id: sid,
      src: incidentId!,
      dst: issueId!,
      type: "relates_to",
    });

    // A decision documents the incident — the payoff link.
    const decision = (await write.invoke(ctx, {
      session_id: sid,
      memory_kind: "semantic",
      type: "decision",
      title: "Add cache-TTL jitter to prevent stampede",
      content: "After the checkout latency incident we jitter cache TTLs to avoid a stampede.",
      project: P,
    })) as { id: string };

    await link.invoke(ctx, {
      session_id: sid,
      src: decision.id,
      dst: incidentId!,
      type: "documents",
    });

    // Drain embeddings so vector + graph expansion are fully exercised.
    for (let i = 0; i < 20; i++) {
      const r = await worker.tick();
      if (r.embedded === 0 && r.failed === 0) break;
    }

    // Searching the decision's topic surfaces the incident (via documents) and reaches the
    // related Sentry issue through the graph.
    const found = (await search.invoke(ctx, {
      session_id: sid,
      query: "cache stampede jitter checkout",
      project: P,
      limits: undefined,
    })) as { results: { id: string }[] };

    const ids = found.results.map((r) => r.id);
    expect(ids).toContain(incidentId);
    expect(ids).toContain(decision.id);

    // Freshness: advance past the window → grafana-prod is flagged stale in session_start.
    const staleIds = async (): Promise<string[]> => {
      const ws = ((await session_start.invoke(ctx, { project: P })) as any).working_set as {
        stale_sources?: { id: string }[];
      };
      return (ws.stale_sources ?? []).map((s) => s.id);
    };
    clock.advanceMs(25 * 3_600_000);
    expect(await staleIds()).toContain("grafana-prod");

    // Re-sync clears staleness.
    await mirror_upsert.invoke(ctx, {
      session_id: sid,
      source_id: "grafana-prod",
      items: [
        {
          native_id: "INC-42",
          type: "incident",
          title: "Checkout latency spike",
          content: "p99 checkout latency crossed 2s for 12 minutes; rolled back deploy #918.",
          url: "https://grafana/incident/42",
          facets: { severity: "sev2", service: "checkout" },
        },
      ],
    });
    expect(await staleIds()).not.toContain("grafana-prod");
  });
});
