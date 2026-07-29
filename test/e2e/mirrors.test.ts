import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { EdgeType, MemoryKind } from "@/core/vocab";
import { LinkTool } from "@/presentation/mcp/tools/link";
import { MirrorUpsertTool } from "@/presentation/mcp/tools/mirror-upsert";
import { SearchTool } from "@/presentation/mcp/tools/search";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { SourceRegisterTool } from "@/presentation/mcp/tools/source-register";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup } from "@test/helpers";

const P = "acme";

const INCIDENT = {
  native_id: "INC-42",
  type: "incident",
  title: "Checkout latency spike",
  content: "p99 checkout latency crossed 2s for 12 minutes; rolled back deploy #918.",
  url: "https://grafana/incident/42",
  facets: { severity: "sev2", service: "checkout" },
};

describe("External mirrors end-to-end", () => {
  it("should mirror, link, surface via graph expansion, and track freshness", async () => {
    // Given
    const env = setup();
    const sessionStart = container.resolve(SessionStartTool);
    const sourceRegister = container.resolve(SourceRegisterTool);
    const mirrorUpsert = container.resolve(MirrorUpsertTool);
    const write = container.resolve(WriteTool);
    const link = container.resolve(LinkTool);
    const search = container.resolve(SearchTool);
    const sid = (await sessionStart.invoke({ project: P })).session_id;

    await sourceRegister.invoke({
      session_id: sid,
      id: "grafana-prod",
      kind: "grafana",
      label: "Grafana (prod)",
      project: P,
      freshness_hours: 24,
    });
    await sourceRegister.invoke({
      session_id: sid,
      id: "sentry",
      kind: "sentry",
      project: P,
      freshness_hours: 24,
    });

    // When — mirror an incident + a related Sentry issue.
    const inc = (await mirrorUpsert.invoke({
      session_id: sid,
      source_id: "grafana-prod",
      items: [INCIDENT],
    })) as { node_ids: string[] };
    const incidentId = inc.node_ids[0];

    const iss = (await mirrorUpsert.invoke({
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
    await link.invoke({
      session_id: sid,
      src: incidentId!,
      dst: issueId!,
      type: EdgeType.RELATES_TO,
    });

    // A decision documents the incident — the payoff link.
    const decision = (await write.invoke({
      session_id: sid,
      memory_kind: MemoryKind.SEMANTIC,
      type: "decision",
      title: "Add cache-TTL jitter to prevent stampede",
      content: "After the checkout latency incident we jitter cache TTLs to avoid a stampede.",
      project: P,
    })) as { id: string };
    await link.invoke({
      session_id: sid,
      src: decision.id,
      dst: incidentId!,
      type: EdgeType.DOCUMENTS,
    });

    // Drain embeddings so vector + graph expansion are fully exercised.
    for (let i = 0; i < 20; i++) {
      const r = await env.worker.tick();
      if (r.embedded === 0 && r.failed === 0) break;
    }

    // Then — searching the decision's topic surfaces the incident (via documents).
    const found = (await search.invoke({
      session_id: sid,
      query: "cache stampede jitter checkout",
      project: P,
      limit: 10,
    })) as { results: { id: string }[] };
    const ids = found.results.map((r) => r.id);
    expect(ids).toContain(incidentId);
    expect(ids).toContain(decision.id);

    // Freshness: advance past the window -> grafana-prod is flagged stale in session_start.
    const staleIds = async (): Promise<string[]> => {
      const ws = (await sessionStart.invoke({ project: P })).working_set as {
        stale_sources?: { id: string }[];
      };
      return (ws.stale_sources ?? []).map((s) => s.id);
    };
    env.clock.advanceMs(25 * 3_600_000);
    expect(await staleIds()).toContain("grafana-prod");

    // Re-sync clears staleness.
    await mirrorUpsert.invoke({
      session_id: sid,
      source_id: "grafana-prod",
      items: [INCIDENT],
    });
    expect(await staleIds()).not.toContain("grafana-prod");
  });
});
