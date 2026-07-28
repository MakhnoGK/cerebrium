import { describe, it, expect, afterEach } from "vitest";
import type BetterSqlite3 from "better-sqlite3";
import { container } from "tsyringe";
import { setup } from "@test/helpers";

import { ConsolidationWorker } from "@/consolidation/worker";
import { toFtsMatch } from "@/core/fts";
import { _MemoryKind } from "@/core/vocab";
import type { SearchRepo } from "@/db/repositories";
import type { Envelope } from "@/db/repo";
import type {
  AnnotateResult,
  AnnotateTask,
  ConsolidationProvider,
  ConsolidationResult,
  ReconcileResult,
} from "@/consolidation/provider";
import { SessionStartTool } from "../src/tools/session-start";
import { WriteTool } from "../src/tools/write";

// An enabled provider that only annotates. `generate`/`reconcile` are unused here.
class FakeAnnotator implements ConsolidationProvider {
  readonly name = "fake";
  readonly version = "1";
  readonly enabled = true;
  calls = 0;
  constructor(private readonly fn: (t: AnnotateTask) => AnnotateResult) {}
  generate(): Promise<ConsolidationResult> {
    return Promise.reject(new Error("not used"));
  }
  reconcile(): Promise<ReconcileResult> {
    return Promise.reject(new Error("not used"));
  }
  annotate(task: AnnotateTask): Promise<AnnotateResult> {
    this.calls++;
    return Promise.resolve(this.fn(task));
  }
}

// A node about failover; the enrichment keyword "resilience" is deliberately ABSENT from
// its title and body, so it is unfindable by that term until annotation folds it in.
const TITLE = "Failover behavior";
const BODY = "the http client switches to the standby node when the primary stops responding";
const KEYWORD = "resilience";

async function writeFact(s: string): Promise<string> {
  return (
    (await container.resolve(WriteTool).invoke({
      session_id: s,
      memory_kind: _MemoryKind.SEMANTIC,
      type: "fact",
      title: TITLE,
      content: BODY,
      project: "infra",
    })) as Envelope
  ).id;
}

// Direct FTS probe: does a text search for `term` return `id`? Proves the annotation
// reached node_fts.content without any vector/embedding involvement.
function ftsFinds(search: SearchRepo, term: string, id: string): boolean {
  const match = toFtsMatch(term);
  if (!match) return false;
  return search
    .search({ match, kinds: ["semantic"], history: false, cap: 10 })
    .rows.some((r) => r.id === id);
}

function annotationRows(db: BetterSqlite3.Database, id: string): unknown[] {
  return db
    .prepare("SELECT node_id, rev, annotations FROM revision_annotations WHERE node_id = ?")
    .all(id);
}

async function session(project?: string): Promise<string> {
  return (await container.resolve(SessionStartTool).invoke({ project })).session_id;
}

afterEach(() => {
  delete process.env.MEMORY_CONSOLIDATE_ANNOTATE;
});

describe("Write-time attribute enrichment (annotate)", () => {
  it("should fold generated keywords into FTS without touching the revision body when auto", async () => {
    // Given
    const provider = new FakeAnnotator(() => ({
      keywords: [KEYWORD, "failover"],
      tags: ["infra"],
      context: "how the client survives a primary outage",
    }));
    const env = setup({ consolidator: provider });
    const id = await writeFact(await session("infra"));
    expect(ftsFinds(env.search, KEYWORD, id)).toBe(false); // injected keyword finds nothing yet

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.annotated).toBe(1);
    expect(provider.calls).toBe(1);
    // findable by the injected keyword and the context phrase…
    expect(ftsFinds(env.search, KEYWORD, id)).toBe(true);
    expect(ftsFinds(env.search, "outage", id)).toBe(true);
    // …but the authored body is byte-for-byte unchanged, and no new revision was created.
    const full = (await env.nodes.fullNode(id))!;
    expect(full.content).toBe(BODY);
    expect(full.envelope.rev).toBe(1);
    expect(annotationRows(env.db, id)).toHaveLength(1);
  });

  it("should re-annotate nothing on a second sweep (idempotent)", async () => {
    // Given
    const provider = new FakeAnnotator(() => ({ keywords: [KEYWORD], tags: [], context: "" }));
    setup({ consolidator: provider });
    await writeFact(await session());

    // When / Then — one worker (one lease holder) across both sweeps tests idempotency.
    const cw = container.resolve(ConsolidationWorker);
    expect((await cw.tick()).annotated).toBe(1);
    expect((await cw.tick()).annotated).toBe(0);
  });

  it("should re-annotate the new revision after an update since annotation is per-rev", async () => {
    // Given
    const provider = new FakeAnnotator(() => ({ keywords: [KEYWORD], tags: [], context: "" }));
    const env = setup({ consolidator: provider });
    const s = await session();
    const id = await writeFact(s);
    const cw = container.resolve(ConsolidationWorker);
    await cw.tick();

    // When — a new revision drops the rev-1 annotation from FTS; the node is un-annotated again.
    env.nodes.addRevision(id, {
      content: `${BODY} and logs the switch`,
      session_id: s,
      reason: null,
      ts: env.clock.now(),
    });

    // Then
    expect(ftsFinds(env.search, KEYWORD, id)).toBe(false);
    expect((await cw.tick()).annotated).toBe(1);
    expect(ftsFinds(env.search, KEYWORD, id)).toBe(true);
  });

  it("should do nothing under the default offline manual provider", async () => {
    // Given
    const env = setup(); // manual, enabled=false
    const id = await writeFact(await session());

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.annotated).toBe(0);
    expect(ftsFinds(env.search, KEYWORD, id)).toBe(false);
  });

  it("should skip enrichment when the posture is off even with an enabled provider", async () => {
    // Given
    process.env.MEMORY_CONSOLIDATE_ANNOTATE = "off";
    const provider = new FakeAnnotator(() => ({ keywords: [KEYWORD], tags: [], context: "" }));
    const env = setup({ consolidator: provider });
    const id = await writeFact(await session());

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.annotated).toBe(0);
    expect(provider.calls).toBe(0);
    expect(ftsFinds(env.search, KEYWORD, id)).toBe(false);
  });

  it("should skip the node on a generation failure with no annotation or FTS change", async () => {
    // Given
    const boom: ConsolidationProvider = {
      name: "boom",
      version: "1",
      enabled: true,
      generate: () => Promise.reject(new Error("no")),
      reconcile: () => Promise.reject(new Error("no")),
      annotate: () => Promise.reject(new Error("model down")),
    };
    const env = setup({ consolidator: boom });
    const id = await writeFact(await session());

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.annotated).toBe(0);
    expect(ftsFinds(env.search, KEYWORD, id)).toBe(false);
    // The node is still authored-body findable — enrichment is purely additive.
    expect(ftsFinds(env.search, "standby", id)).toBe(true);
  });
});
