import { describe, it, expect, afterEach } from "vitest";
import type BetterSqlite3 from "better-sqlite3";
import { makeCtx } from "./helpers";
import * as session_start from "@/tools/session_start";
import * as write from "@/tools/write";
import { ConsolidationWorker } from "@/consolidation/worker";
import { toFtsMatch } from "@/core/fts";
import type { Ctx } from "@/tools/context";
import type { Repo, Envelope } from "@/db/repo";
import type {
  AnnotateResult,
  AnnotateTask,
  ConsolidationProvider,
  ConsolidationResult,
  ReconcileResult,
} from "@/consolidation/provider";

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

async function writeFact(ctx: Ctx, s: string): Promise<string> {
  return (
    (await write.handler(ctx, {
      session_id: s,
      memory_kind: "semantic",
      type: "fact",
      title: TITLE,
      content: BODY,
      project: "infra",
    })) as Envelope
  ).id;
}

// Direct FTS probe: does a text search for `term` return `id`? Proves the annotation
// reached node_fts.content without any vector/embedding involvement.
function ftsFinds(repo: Repo, term: string, id: string): boolean {
  const match = toFtsMatch(term);
  if (!match) return false;
  return repo
    .search({ match, kinds: ["semantic"], history: false, cap: 10 })
    .rows.some((r) => r.id === id);
}

function annotationRows(db: BetterSqlite3.Database, id: string): unknown[] {
  return db
    .prepare("SELECT node_id, rev, annotations FROM revision_annotations WHERE node_id = ?")
    .all(id);
}

afterEach(() => {
  delete process.env.MEMORY_CONSOLIDATE_ANNOTATE;
});

describe("write-time attribute enrichment (annotate)", () => {
  it("auto folds generated keywords into FTS without touching the revision body", async () => {
    const provider = new FakeAnnotator(() => ({
      keywords: [KEYWORD, "failover"],
      tags: ["infra"],
      context: "how the client survives a primary outage",
    }));
    const { ctx, repo, db } = makeCtx({ consolidator: provider });
    const s = (await session_start.handler(ctx, { project: "infra" })).session_id;
    const id = await writeFact(ctx, s);

    // Before enrichment: the injected keyword finds nothing.
    expect(ftsFinds(repo, KEYWORD, id)).toBe(false);

    const r = await new ConsolidationWorker(repo, provider, ctx.now).tick();
    expect(r.annotated).toBe(1);
    expect(provider.calls).toBe(1);

    // After enrichment: findable by the injected keyword and the context phrase…
    expect(ftsFinds(repo, KEYWORD, id)).toBe(true);
    expect(ftsFinds(repo, "outage", id)).toBe(true);
    // …but the authored body is byte-for-byte unchanged, and no new revision was created.
    const full = repo.fullNode(id)!;
    expect(full.content).toBe(BODY);
    expect(full.envelope.rev).toBe(1);
    expect(annotationRows(db, id)).toHaveLength(1);
  });

  it("is idempotent — a second sweep re-annotates nothing", async () => {
    const provider = new FakeAnnotator(() => ({ keywords: [KEYWORD], tags: [], context: "" }));
    const { ctx, repo } = makeCtx({ consolidator: provider });
    const s = (await session_start.handler(ctx, {})).session_id;
    await writeFact(ctx, s);

    // One worker (one lease holder) across both sweeps, so the second sweep tests
    // idempotency — not a denied lease.
    const cw = new ConsolidationWorker(repo, provider, ctx.now);
    expect((await cw.tick()).annotated).toBe(1);
    expect((await cw.tick()).annotated).toBe(0);
  });

  it("re-annotates the new revision after an update (annotation is per-rev)", async () => {
    const provider = new FakeAnnotator(() => ({ keywords: [KEYWORD], tags: [], context: "" }));
    const { ctx, repo } = makeCtx({ consolidator: provider });
    const s = (await session_start.handler(ctx, {})).session_id;
    const id = await writeFact(ctx, s);
    const cw = new ConsolidationWorker(repo, provider, ctx.now);
    await cw.tick();

    // A new revision drops the rev-1 annotation from FTS; the node is un-annotated again.
    repo.addRevision(id, {
      content: `${BODY} and logs the switch`,
      session_id: s,
      reason: null,
      ts: ctx.now(),
    });
    expect(ftsFinds(repo, KEYWORD, id)).toBe(false);
    expect((await cw.tick()).annotated).toBe(1);
    expect(ftsFinds(repo, KEYWORD, id)).toBe(true);
  });

  it("does nothing under the default offline (manual) provider", async () => {
    const { ctx, repo } = makeCtx(); // manual, enabled=false
    const s = (await session_start.handler(ctx, {})).session_id;
    const id = await writeFact(ctx, s);
    const r = await new ConsolidationWorker(repo, ctx.consolidator, ctx.now).tick();
    expect(r.annotated).toBe(0);
    expect(ftsFinds(repo, KEYWORD, id)).toBe(false);
  });

  it("off posture skips enrichment even with an enabled provider", async () => {
    process.env.MEMORY_CONSOLIDATE_ANNOTATE = "off";
    const provider = new FakeAnnotator(() => ({ keywords: [KEYWORD], tags: [], context: "" }));
    const { ctx, repo } = makeCtx({ consolidator: provider });
    const s = (await session_start.handler(ctx, {})).session_id;
    const id = await writeFact(ctx, s);
    const r = await new ConsolidationWorker(repo, provider, ctx.now).tick();
    expect(r.annotated).toBe(0);
    expect(provider.calls).toBe(0);
    expect(ftsFinds(repo, KEYWORD, id)).toBe(false);
  });

  it("a generation failure skips the node — no annotation, no FTS change", async () => {
    const boom: ConsolidationProvider = {
      name: "boom",
      version: "1",
      enabled: true,
      generate: () => Promise.reject(new Error("no")),
      reconcile: () => Promise.reject(new Error("no")),
      annotate: () => Promise.reject(new Error("model down")),
    };
    const { ctx, repo } = makeCtx({ consolidator: boom });
    const s = (await session_start.handler(ctx, {})).session_id;
    const id = await writeFact(ctx, s);
    const r = await new ConsolidationWorker(repo, boom, ctx.now).tick();
    expect(r.annotated).toBe(0);
    expect(ftsFinds(repo, KEYWORD, id)).toBe(false);
    // The node is still authored-body findable — enrichment is purely additive.
    expect(ftsFinds(repo, "standby", id)).toBe(true);
  });
});
