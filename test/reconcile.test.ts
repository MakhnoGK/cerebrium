import { describe, it, expect, afterEach, beforeEach, afterAll } from "vitest";
import { makeCtx } from "@test/helpers";
import type {
  ConsolidationProvider,
  ConsolidationResult,
  ReconcileResult,
  ReconcileTask,
} from "@/consolidation/provider";
import { SessionStartTool } from "../src/tools/session-start";
import { WriteTool } from "../src/tools/write";
import { container } from "tsyringe";
import { CONSOLIDATOR_TOKEN } from "../src/tools/services/consolidation.service";
import { EMBEDDING_PROVIDER_TOKEN, EmbeddingProvider } from "../src/embeddings";
import { EmbeddingWorker } from "../src/embeddings/worker";
import { LocalNullProvider } from "../src/embeddings/local-null";
import Database from "better-sqlite3";
import { DB_TOKEN } from "../src/db/repositories/base";
import { openDatabase } from "../src/db/database";
import { createConsolidator } from "../src/consolidation";

const session_start = container.resolve(SessionStartTool);

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

async function session(project?: string): Promise<string> {
  return (await session_start.invoke({ project })).session_id;
}

function writeFact(s: string, title: string, content: string): Promise<WriteOut> {
  const write = container.resolve(WriteTool);

  return write.invoke({
    session_id: s,
    memory_kind: "semantic",
    type: "fact",
    title,
    content,
    project: P,
  }) as Promise<WriteOut>;
}

beforeEach(() => {
  container.register<EmbeddingProvider>(EMBEDDING_PROVIDER_TOKEN, {
    useValue: new LocalNullProvider(),
  });
});

afterEach(() => {
  delete process.env.MEMORY_CONSOLIDATE_RECONCILE;
});

describe("Write-time reconcile", () => {
  beforeEach(() => {
    container.register(CONSOLIDATOR_TOKEN, { useValue: createConsolidator("manual") });
  });

  afterEach(() => {
    container.register(DB_TOKEN, { useValue: openDatabase(":memory:") });
  });

  afterAll(() => {
    container.resolve<Database.Database>(DB_TOKEN).close();
  });

  it("should return a judged action naming the target when a near-duplicate is written", async () => {
    // Given
    const judge = new FakeJudge((t) => ({
      action: "update",
      target_id: t.candidates[0]!.id,
      reason: "refines the existing token TTL fact",
    }));

    container.registerInstance(CONSOLIDATOR_TOKEN, judge);
    const worker = container.resolve(EmbeddingWorker);

    const s = await session(P);
    const original = await writeFact(s, "Token TTL", ORIGINAL);
    await worker.tick(); // embed the original so the vector dedup probe finds it

    // When
    const dup = await writeFact(s, "Token TTL", ORIGINAL);

    // Then
    expect(dup.similar_existing?.[0]?.id).toBe(original.id);
    expect(dup.reconcile).toEqual({
      action: "update",
      target_id: original.id,
      reason: "refines the existing token TTL fact",
    });
    // The judge saw the resembling record with its full content, not just a summary.
    expect(judge.calls).toBe(1);
  });

  it("should not call the judge or return reconcile when there is no near-duplicate", async () => {
    // Given
    const judge = new FakeJudge(() => ({ action: "update", target_id: "x", reason: "" }));

    container.registerInstance(CONSOLIDATOR_TOKEN, judge);
    const worker = container.resolve(EmbeddingWorker);

    const s = await session(P);
    await writeFact(s, "Token TTL", ORIGINAL);
    await worker.tick();

    // When
    const unrelated = await writeFact(s, "Deploy cadence", "we ship the app every thursday");

    // Then
    expect(unrelated.similar_existing).toBeUndefined();
    expect(unrelated.reconcile).toBeUndefined();
    expect(judge.calls).toBe(0);
  });

  it("should decay the verdict to noop when it names an unknown target", async () => {
    // Given
    const judge = new FakeJudge(() => ({
      action: "supersede",
      target_id: "01NOTACANDIDATE",
      reason: "hallucinated target",
    }));

    container.registerInstance(CONSOLIDATOR_TOKEN, judge);
    const worker = container.resolve(EmbeddingWorker);

    const s = await session(P);
    await writeFact(s, "Token TTL", ORIGINAL);
    await worker.tick();

    // When
    const dup = await writeFact(s, "Token TTL", ORIGINAL);

    // Then
    expect(dup.reconcile).toEqual({
      action: "noop",
      target_id: null,
      reason: "hallucinated target",
    });
  });

  it("should skip reconcile but still return the advisory hint when MEMORY_CONSOLIDATE_RECONCILE is off", async () => {
    // Given
    process.env.MEMORY_CONSOLIDATE_RECONCILE = "off";

    const judge = new FakeJudge((t) => ({
      action: "update",
      target_id: t.candidates[0]!.id,
      reason: "x",
    }));

    container.registerInstance(CONSOLIDATOR_TOKEN, judge);
    const worker = container.resolve(EmbeddingWorker);

    const s = await session(P);
    const original = await writeFact(s, "Token TTL", ORIGINAL);
    await worker.tick();

    // When
    const dup = await writeFact(s, "Token TTL", ORIGINAL);

    // Then
    expect(dup.similar_existing?.[0]?.id).toBe(original.id); // probe unaffected
    expect(dup.reconcile).toBeUndefined();
    expect(judge.calls).toBe(0);
  });

  it("should not return reconcile when the default manual provider is active", async () => {
    // Given
    const worker = container.resolve(EmbeddingWorker);

    const s = await session(P);
    await writeFact(s, "Token TTL", ORIGINAL);
    await worker.tick();

    // When
    const dup = await writeFact(s, "Token TTL", ORIGINAL);

    // Then
    expect(dup.similar_existing).toBeDefined();
    expect(dup.reconcile).toBeUndefined();
  });

  it("should still succeed without reconcile when the provider fails", async () => {
    // Given
    const boom: ConsolidationProvider = {
      name: "boom",
      version: "1",
      enabled: true,
      generate: () => Promise.reject(new Error("no")),
      reconcile: () => Promise.reject(new Error("provider down")),
    };

    container.registerInstance(CONSOLIDATOR_TOKEN, boom);
    const worker = container.resolve(EmbeddingWorker);

    const s = await session(P);
    const original = await writeFact(s, "Token TTL", ORIGINAL);
    await worker.tick();

    // When
    const dup = await writeFact(s, "Token TTL", ORIGINAL);

    // Then
    expect(dup.id).toBeDefined();
    expect(dup.similar_existing?.[0]?.id).toBe(original.id);
    expect(dup.reconcile).toBeUndefined();
  });
});
