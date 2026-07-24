import { describe, it, expect } from "vitest";
import { makeCtx } from "./helpers";
import * as session_start from "@/tools/session_start";
import * as write from "@/tools/write";
import * as search from "@/tools/search";
import type { Ctx } from "@/tools/context";
import type { Envelope } from "@/db/repo";

async function session(ctx: Ctx): Promise<string> {
  return (await session_start.handler(ctx, {})).session_id;
}
function ids(res: Awaited<ReturnType<typeof search.handler>>): string[] {
  return (res.results as Envelope[]).map((e) => e.id);
}

describe("ranking blends text relevance with the memory model", () => {
  it("ranks a fresh episodic checkpoint above a 60-day-old one, and a semantic fact above both", async () => {
    const { ctx, clock } = makeCtx();
    const s = await session(ctx);
    const content = "deploy the release pipeline";

    const old = (await write.handler(ctx, {
      session_id: s,
      memory_kind: "episodic",
      type: "checkpoint",
      title: "Deploy",
      content,
    })) as Envelope;
    clock.advanceDays(59);
    const fresh = (await write.handler(ctx, {
      session_id: s,
      memory_kind: "episodic",
      type: "checkpoint",
      title: "Deploy",
      content,
    })) as Envelope;
    clock.advanceDays(1);
    const fact = (await write.handler(ctx, {
      session_id: s,
      memory_kind: "semantic",
      type: "fact",
      title: "Deploy",
      content,
    })) as Envelope;

    const res = await search.handler(ctx, { session_id: s, query: "deploy pipeline", limit: 10 });
    expect(ids(res)).toEqual([fact.id, fresh.id, old.id]);
  });

  it("drops episodic decay under history:true so a stronger-but-older text match wins", async () => {
    const { ctx, clock } = makeCtx();
    const s = await session(ctx);

    const old = (await write.handler(ctx, {
      session_id: s,
      memory_kind: "episodic",
      type: "checkpoint",
      title: "x",
      content: "deploy deploy deploy deploy pipeline",
    })) as Envelope;
    clock.advanceDays(60);
    const fresh = (await write.handler(ctx, {
      session_id: s,
      memory_kind: "episodic",
      type: "checkpoint",
      title: "x",
      content: "deploy",
    })) as Envelope;

    const normal = await search.handler(ctx, { session_id: s, query: "deploy", limit: 10 });
    expect(ids(normal)[0]).toBe(fresh.id); // decay sinks the old one

    const hist = await search.handler(ctx, {
      session_id: s,
      query: "deploy",
      history: true,
      limit: 10,
    });
    expect(ids(hist)[0]).toBe(old.id); // no decay: the stronger text match wins
  });
});

describe("search is robust and filterable", () => {
  it("never throws on a malformed query", async () => {
    const { ctx } = makeCtx();
    const s = await session(ctx);
    await write.handler(ctx, {
      session_id: s,
      memory_kind: "semantic",
      type: "fact",
      title: "T",
      content: "alpha beta",
    });
    const res = await search.handler(ctx, {
      session_id: s,
      query: 'alpha AND ) OR * "',
      limit: 10,
    });
    expect(res.total_matches).toBe(1);
  });

  it("returns nothing for an all-punctuation query without error", async () => {
    const { ctx } = makeCtx();
    const s = await session(ctx);
    const res = await search.handler(ctx, { session_id: s, query: "!!! ??? ...", limit: 10 });
    expect(res.total_matches).toBe(0);
    expect(res.results).toEqual([]);
  });

  it("filters by kind and type", async () => {
    const { ctx } = makeCtx();
    const s = await session(ctx);
    await write.handler(ctx, {
      session_id: s,
      memory_kind: "semantic",
      type: "fact",
      title: "A",
      content: "shared term",
    });
    await write.handler(ctx, {
      session_id: s,
      memory_kind: "episodic",
      type: "event_note",
      title: "B",
      content: "shared term",
    });
    const onlySemantic = await search.handler(ctx, {
      session_id: s,
      query: "shared",
      kinds: ["semantic"],
      limit: 10,
    });
    expect(onlySemantic.total_matches).toBe(1);
    expect((onlySemantic.results as Envelope[])[0]!.kind).toBe("semantic");
  });
});
