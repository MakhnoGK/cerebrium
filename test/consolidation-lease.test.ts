import { container } from "tsyringe";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConsolidationRecommendation,
  type ConsolidationProvider,
} from "@/domain/ports/consolidation-provider";
import { ConsolidationWorker } from "@/application/workers";
import type { Envelope } from "@/db/repo";
import { ConsolidationKind, MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { ConsolidationConfig } from "@/infrastructure/config";
import { setup, TestEnv } from "@test/helpers";

const START = "2026-01-01T00:00:00.000Z";
const GENERATION_MS = 200_000;

interface Holder {
  env?: TestEnv;
  worker?: ConsolidationWorker;
}

function leaseExpiry(env: TestEnv): string | undefined {
  const row = env.db
    .prepare("SELECT expires_at FROM worker_lease WHERE role = 'consolidation'")
    .get() as { expires_at: string } | undefined;

  return row?.expires_at;
}

// Stands in for a slow local model: every call burns wall-clock on the injected clock,
// which is what makes a lease claimed once at tick entry lapse mid-sweep. The holder
// exists because the provider is constructed before the env it reads.
function slowProvider(holder: Holder, onGenerate?: () => void): ConsolidationProvider {
  return {
    name: "slow-stub",
    version: "1",
    enabled: true,
    generate: () => {
      holder.env!.clock.advanceMs(GENERATION_MS);
      onGenerate?.();

      return Promise.resolve({
        recommendation: ConsolidationRecommendation.APPLY,
        reason: "same fact",
        title: "Drafted",
        summary: "S",
        body: "drafted body",
      });
    },
    reconcile: () => Promise.reject(new Error("not used")),
    annotate: () => Promise.reject(new Error("not used")),
  };
}

// Three proposal-less merge candidates over unrelated facts, so the backfill loop is the
// only generating stage of the tick — nothing here is similar enough to detect.
async function queueThree(env: TestEnv): Promise<string[]> {
  const s = (await container.resolve(SessionStartTool).invoke({})).session_id;
  const topics = ["payments authorize capture", "kafka partitions tenants", "graph edge pruning"];
  const ids: string[] = [];

  for (const [i, topic] of topics.entries()) {
    const members: string[] = [];

    for (const suffix of ["a", "b"]) {
      const node = (await container.resolve(WriteTool).invoke({
        session_id: s,
        parent_node_id: null,
        memory_kind: MemoryKind.SEMANTIC,
        type: "fact",
        title: `${topic} ${suffix}`,
        content: `${topic} ${suffix}`,
      })) as Envelope;

      members.push(node.id);
    }

    ids.push(
      env.consolidation.insertCandidate({
        kind: ConsolidationKind.MERGE,
        member_ids: members,
        canonical_id: members[0]!,
        score: 0.95 - i / 100,
        detected_at: START,
      })!,
    );
  }

  return ids;
}

afterEach(() => {
  delete process.env.MEMORY_CONSOLIDATE_ANNOTATE;
});

describe("Consolidation worker lease", () => {
  it("should renew the lease between clusters when generation outlasts the claim made at tick entry", async () => {
    // Given
    process.env.MEMORY_CONSOLIDATE_ANNOTATE = "off";
    const holder: Holder = {};
    const env = setup({ start: START, consolidator: slowProvider(holder) });
    holder.env = env;
    const ids = await queueThree(env);
    const ttl = container.resolve(ConsolidationConfig).leaseTtlMs;

    // When
    await container.resolve(ConsolidationWorker).tick();

    // Then — the last renewal is the one before the final candidate's generation call,
    // so the lease outlives what a single claim at tick entry would have covered.
    const lastRenewal = Date.parse(START) + (ids.length - 1) * GENERATION_MS;
    expect(leaseExpiry(env)).toBe(new Date(lastRenewal + ttl).toISOString());
    expect(Date.parse(leaseExpiry(env)!)).toBeGreaterThan(Date.parse(START) + ttl);
  });

  it("should end the sweep where it stands and leave the lease released when stopped mid-tick", async () => {
    // Given
    process.env.MEMORY_CONSOLIDATE_ANNOTATE = "off";
    const holder: Holder = {};
    const env = setup({
      start: START,
      consolidator: slowProvider(holder, () => void holder.worker!.stop()),
    });
    holder.env = env;
    const ids = await queueThree(env);
    holder.worker = container.resolve(ConsolidationWorker);

    // When
    const r = await holder.worker.tick();

    // Then
    expect(r.proposals_backfilled).toBe(1);
    expect(ids.slice(1).map((id) => env.consolidation.getCandidate(id)!.proposal)).toEqual([
      null,
      null,
    ]);
    expect(leaseExpiry(env)).toBeUndefined();
  });
});
