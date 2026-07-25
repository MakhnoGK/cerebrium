import { describe, it, expect } from "vitest";
import { makeCtx } from "@test/helpers";
import type { Ctx } from "@/tools/context";
import type { Envelope } from "@/db/repo";
import { SessionStartTool } from "../src/tools/session_start";
import { WriteTool } from "../src/tools/write";
import { SearchTool } from "../src/tools/search";

const session_start = new SessionStartTool();
const write = new WriteTool();
const search = new SearchTool();

async function session(ctx: Ctx): Promise<string> {
  return (await session_start.invoke(ctx, {})).session_id;
}
function ids(res: Awaited<ReturnType<typeof search.invoke>>): string[] {
  return res.results.map((e) => e.id);
}

describe("ranking blends text relevance with the memory model", () => {
  it("ranks a fresh episodic checkpoint above a 60-day-old one, and a semantic fact above both", async () => {
    const { ctx, clock } = makeCtx();
    const s = await session(ctx);
    const content = "deploy the release pipeline";

    const old = (await write.invoke(ctx, {
      session_id: s,
      memory_kind: "episodic",
      type: "checkpoint",
      title: "Deploy",
      content,
    })) as Envelope;
    clock.advanceDays(59);
    const fresh = (await write.invoke(ctx, {
      session_id: s,
      memory_kind: "episodic",
      type: "checkpoint",
      title: "Deploy",
      content,
    })) as Envelope;
    clock.advanceDays(1);
    const fact = (await write.invoke(ctx, {
      session_id: s,
      memory_kind: "semantic",
      type: "fact",
      title: "Deploy",
      content,
    })) as Envelope;

    const res = await search.invoke(ctx, { session_id: s, query: "deploy pipeline", limit: 10 });
    expect(ids(res)).toEqual([fact.id, fresh.id, old.id]);
  });

  it("drops episodic decay under history:true so a stronger-but-older text match wins", async () => {
    const { ctx, clock } = makeCtx();
    const s = await session(ctx);

    const old = (await write.invoke(ctx, {
      session_id: s,
      memory_kind: "episodic",
      type: "checkpoint",
      title: "x",
      content: "deploy deploy deploy deploy pipeline",
    })) as Envelope;
    clock.advanceDays(60);
    const fresh = (await write.invoke(ctx, {
      session_id: s,
      memory_kind: "episodic",
      type: "checkpoint",
      title: "x",
      content: "deploy",
    })) as Envelope;

    const normal = await search.invoke(ctx, { session_id: s, query: "deploy", limit: 10 });
    expect(ids(normal)[0]).toBe(fresh.id); // decay sinks the old one

    const hist = await search.invoke(ctx, {
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
    await write.invoke(ctx, {
      session_id: s,
      memory_kind: "semantic",
      type: "fact",
      title: "T",
      content: "alpha beta",
    });
    const res = await search.invoke(ctx, {
      session_id: s,
      query: 'alpha AND ) OR * "',
      limit: 10,
    });
    expect(res.total_matches).toBe(1);
  });

  it("returns nothing for an all-punctuation query without error", async () => {
    const { ctx } = makeCtx();
    const s = await session(ctx);
    const res = await search.invoke(ctx, { session_id: s, query: "!!! ??? ...", limit: 10 });
    expect(res.total_matches).toBe(0);
    expect(res.results).toEqual([]);
  });

  it("filters by kind and type", async () => {
    const { ctx } = makeCtx();
    const s = await session(ctx);
    await write.invoke(ctx, {
      session_id: s,
      memory_kind: "semantic",
      type: "fact",
      title: "A",
      content: "shared term",
    });
    await write.invoke(ctx, {
      session_id: s,
      memory_kind: "episodic",
      type: "event_note",
      title: "B",
      content: "shared term",
    });
    const onlySemantic = await search.invoke(ctx, {
      session_id: s,
      query: "shared",
      kinds: ["semantic"],
      limit: 10,
    });
    expect(onlySemantic.total_matches).toBe(1);
    expect(onlySemantic.results[0]!.kind).toBe("semantic");
  });
});
