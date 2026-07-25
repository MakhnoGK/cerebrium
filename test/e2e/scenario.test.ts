import { describe, it, expect } from "vitest";
import { makeCtx } from "../helpers";
import type { Envelope } from "@/db/repo";
import { SessionStartTool } from "../../src/tools/session_start";
import { WriteTool } from "../../src/tools/write";
import { GetTool } from "../../src/tools/get";
import { SearchTool } from "../../src/tools/search";
import { UpdateTool } from "../../src/tools/update";
import { CheckpointTool } from "../../src/tools/checkpoint";

const session_start = new SessionStartTool();
const write = new WriteTool();
const get = new GetTool();
const search = new SearchTool();
const update = new UpdateTool();
const checkpoint = new CheckpointTool();

const P = "auth-service";

// Acceptance §8.2: session A writes -> session B orients, searches, gets, updates
// -> revision history shows both sessions.
describe("multi-session hand-off", () => {
  it("carries context from one session to the next", async () => {
    const { ctx } = makeCtx();

    // ---- Session A: write 3 facts + 1 checkpoint --------------------------
    const a = (await session_start.invoke(ctx, { project: P })).session_id;
    const f1 = (await write.invoke(ctx, {
      session_id: a,
      memory_kind: "semantic",
      type: "fact",
      title: "Token TTL",
      content: "access tokens live 15 minutes",
      project: P,
    })) as Envelope;
    await write.invoke(ctx, {
      session_id: a,
      memory_kind: "semantic",
      type: "decision",
      title: "Use RS256",
      content: "sign JWTs with RS256, not HS256",
      project: P,
    });
    await write.invoke(ctx, {
      session_id: a,
      memory_kind: "semantic",
      type: "fact",
      title: "Refresh flow",
      content: "refresh tokens rotate on use",
      project: P,
    });
    await checkpoint.invoke(ctx, {
      session_id: a,
      project: P,
      summary: "wired up JWT auth end to end",
      decisions: ["RS256 over HS256"],
      open_threads: ["add refresh-token revocation"],
      touched_node_ids: [f1.id],
    });

    // ---- Session B: orient via session_start ------------------------------
    const bStart = await session_start.invoke(ctx, { project: P });
    const b = bStart.session_id;
    expect(b).not.toBe(a);
    const ws = bStart.working_set as {
      semantic: Envelope[];
      checkpoints: { envelope: Envelope; content: string }[];
    };
    expect(ws.checkpoints[0]!.content).toContain("wired up JWT auth end to end");
    expect(ws.semantic.map((e) => e.title)).toContain("Token TTL");

    // ---- Session B: search, get, update a fact ----------------------------
    const found = await search.invoke(ctx, {
      session_id: b,
      query: "access tokens",
      project: P,
      limit: 5,
    });
    const hit = found.results.find((e) => e.id === f1.id);
    expect(hit).toBeDefined();

    const full = ((get) => (get as { nodes: { content: string }[] }).nodes[0])(
      await get.invoke(ctx, { session_id: b, ids: [f1.id] }),
    );
    expect(full!.content).toContain("15 minutes");

    await update.invoke(ctx, {
      session_id: b,
      id: f1.id,
      content: "access tokens live 10 minutes",
      reason: "shortened TTL",
    });

    // ---- Revision history shows both sessions -----------------------------
    const withRevs = ((r) =>
      (r as { nodes: { revisions: { rev: number; session_id: string }[] }[] }).nodes[0])(
      await get.invoke(ctx, { session_id: b, ids: [f1.id], include_revisions: true }),
    );
    const revSessions = withRevs!.revisions.map((rv) => rv.session_id);
    expect(revSessions).toEqual([a, b]);
  });
});
