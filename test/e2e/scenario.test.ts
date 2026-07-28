import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import type { Envelope } from "@/db/repo";
import { _MemoryKind } from "@/core/vocab";
import { CheckpointTool } from "@/tools/checkpoint";
import { GetTool } from "@/tools/get";
import { SearchTool } from "@/tools/search";
import { SessionStartTool } from "@/tools/session-start";
import { UpdateTool } from "@/tools/update";
import { WriteTool } from "@/tools/write";
import { setup } from "@test/helpers";

const P = "auth-service";

function tools() {
  return {
    sessionStart: container.resolve(SessionStartTool),
    write: container.resolve(WriteTool),
    get: container.resolve(GetTool),
    search: container.resolve(SearchTool),
    update: container.resolve(UpdateTool),
    checkpoint: container.resolve(CheckpointTool),
  };
}

describe("Multi-session hand-off", () => {
  it("should carry context from one session to the next", async () => {
    // Given
    setup();
    const t = tools();

    // ---- Session A: write 3 facts + 1 checkpoint --------------------------
    const a = (await t.sessionStart.invoke({ project: P })).session_id;
    const f1 = (await t.write.invoke({
      session_id: a,
      memory_kind: _MemoryKind.SEMANTIC,
      type: "fact",
      title: "Token TTL",
      content: "access tokens live 15 minutes",
      project: P,
    })) as Envelope;
    await t.write.invoke({
      session_id: a,
      memory_kind: _MemoryKind.SEMANTIC,
      type: "decision",
      title: "Use RS256",
      content: "sign JWTs with RS256, not HS256",
      project: P,
    });
    await t.write.invoke({
      session_id: a,
      memory_kind: _MemoryKind.SEMANTIC,
      type: "fact",
      title: "Refresh flow",
      content: "refresh tokens rotate on use",
      project: P,
    });
    await t.checkpoint.invoke({
      session_id: a,
      project: P,
      summary: "wired up JWT auth end to end",
      decisions: ["RS256 over HS256"],
      open_threads: ["add refresh-token revocation"],
      touched_node_ids: [f1.id],
    });

    // ---- Session B: orient via session_start ------------------------------
    // When
    const bStart = await t.sessionStart.invoke({ project: P });
    const b = bStart.session_id;

    // Then
    expect(b).not.toBe(a);
    const ws = bStart.working_set as {
      semantic: Envelope[];
      checkpoints: { envelope: Envelope; content: string }[];
    };
    expect(ws.checkpoints[0]!.content).toContain("wired up JWT auth end to end");
    expect(ws.semantic.map((e) => e.title)).toContain("Token TTL");

    // ---- Session B: search, get, update a fact ----------------------------
    const found = await t.search.invoke({
      session_id: b,
      query: "access tokens",
      project: P,
      limit: 5,
    });
    expect(found.results.find((e) => e.id === f1.id)).toBeDefined();

    const full = ((res) => (res as { nodes: { content: string }[] }).nodes[0])(
      await t.get.invoke({ session_id: b, ids: [f1.id] }),
    );
    expect(full!.content).toContain("15 minutes");

    await t.update.invoke({
      session_id: b,
      id: f1.id,
      content: "access tokens live 10 minutes",
      reason: "shortened TTL",
    });

    // ---- Revision history shows both sessions -----------------------------
    const withRevs = ((r) =>
      (r as { nodes: { revisions: { rev: number; session_id: string }[] }[] }).nodes[0])(
      await t.get.invoke({ session_id: b, ids: [f1.id], include_revisions: true }),
    );
    expect(withRevs!.revisions.map((rv) => rv.session_id)).toEqual([a, b]);
  });
});
