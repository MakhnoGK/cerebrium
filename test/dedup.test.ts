import { describe, it, expect } from "vitest";
import { makeCtx } from "./helpers";
import type { Ctx } from "@/tools/context";
import { SessionStartTool } from "../src/tools/session_start";
import { WriteTool } from "../src/tools/write";

const session_start = new SessionStartTool();
const write = new WriteTool();

async function session(ctx: Ctx, project?: string): Promise<string> {
  return (await session_start.invoke(ctx, { project })).session_id;
}
type WriteOut = Record<string, unknown> & {
  id: string;
  similar_existing?: { id: string; score: number }[];
  context_notes?: string[];
};
function writeFact(
  ctx: Ctx,
  s: string,
  title: string,
  content: string,
  project?: string,
): Promise<WriteOut> {
  return write.invoke(ctx, {
    session_id: s,
    memory_kind: "semantic",
    type: "fact",
    title,
    content,
    project,
  }) as Promise<WriteOut>;
}

const P = "billing";
const ORIGINAL =
  "Access tokens live fifteen minutes before they expire and then must be refreshed by the client";

describe("duplicate detection at write time", () => {
  it("fires on a near-duplicate and stays silent on an unrelated write", async () => {
    const { ctx, worker } = makeCtx();
    const s = await session(ctx, P);
    const original = await writeFact(ctx, s, "Token TTL", ORIGINAL, P);
    await worker.tick(); // embed the original so the vector probe can find it

    const dup = await writeFact(ctx, s, "Token TTL", ORIGINAL, P); // same fact again
    expect(dup.similar_existing?.[0]?.id).toBe(original.id);
    expect(dup.similar_existing![0]!.score).toBeGreaterThanOrEqual(0.82);
    expect((dup.context_notes ?? []).some((n) => n.startsWith("Possible duplicate of"))).toBe(true);

    const unrelated = await writeFact(
      ctx,
      s,
      "Deploy cadence",
      "we ship the mobile app every second thursday",
      P,
    );
    expect(unrelated.similar_existing).toBeUndefined();
    expect((unrelated.context_notes ?? []).some((n) => n.startsWith("Possible duplicate of"))).toBe(
      false,
    );
  });

  it("checkpoints/episodic writes are exempt from the probe", async () => {
    const { ctx, worker } = makeCtx();
    const s = await session(ctx, P);
    await writeFact(ctx, s, "Token TTL", ORIGINAL, P);
    await worker.tick();

    const note = (await write.invoke(ctx, {
      session_id: s,
      memory_kind: "episodic",
      type: "event_note",
      title: "Token TTL",
      content: ORIGINAL,
      project: P,
    })) as WriteOut;
    expect(note.similar_existing).toBeUndefined();
  });

  it("falls back to a lexical probe when nothing is embedded yet", async () => {
    const { ctx } = makeCtx();
    const s = await session(ctx, P);
    const original = await writeFact(ctx, s, "Token TTL", ORIGINAL, P); // never drained
    const dup = await writeFact(ctx, s, "Token TTL", ORIGINAL, P);
    expect(dup.similar_existing?.[0]?.id).toBe(original.id); // caught via Jaccard fallback
  });
});
