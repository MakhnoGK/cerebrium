import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { CallPipeline } from "@/application/call-pipeline";
import { ReviewService } from "@/application/services";
import { CALL_SURFACE, callCapability } from "@/application/use-cases";
import { edgeRef } from "@/db/repositories";
import {
  Capability,
  EdgeType,
  MemoryKind,
  Posture,
  ReviewArtifact,
  ReviewDecision,
} from "@/core/vocab";
import {
  NEUTRAL_WEIGHT,
  OPEN_PROFILE,
  PrincipalsConfig,
  type PrincipalProfile,
} from "@/infrastructure/config";
import { setup, type TestEnv } from "@test/helpers";

let env: TestEnv;

const RUNNER = "cerebrium-runner";
const HUMAN = "claude-code";

function profile(capabilities: PrincipalProfile["capabilities"]): PrincipalProfile {
  return { capabilities, quota: {}, weight: NEUTRAL_WEIGHT };
}

const SUGGESTS = profile({ write: Posture.SUGGEST, consolidate: Posture.OFF });

function policy(profiles: Record<string, PrincipalProfile>, fallback = OPEN_PROFILE) {
  container.register(PrincipalsConfig, { useValue: { profiles, default: fallback } });
}

function pipeline(): CallPipeline {
  return container.resolve(CallPipeline);
}

async function session(client: string): Promise<string> {
  const started = (await pipeline().invoke(
    container,
    "start_session",
    {},
    { client, version: null },
  )) as { session_id: string };

  return started.session_id;
}

async function note(session_id: string, title: string): Promise<string> {
  const written = (await pipeline().invoke(
    container,
    "write_memory",
    {
      session_id,
      parent_node_id: null,
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title,
      content: `${title} — a durable fact with enough words in it to make a chunk worth keeping`,
    },
    { client: HUMAN, version: null },
  )) as { envelope: { id: string } };

  return written.envelope.id;
}

async function link(session_id: string, src: string, dst: string, client: string): Promise<void> {
  await pipeline().invoke(
    container,
    "link_nodes",
    { session_id, src, dst, type: EdgeType.DOCUMENTS },
    { client, version: null },
  );
}

// Two notes authored by the human, joined by an edge the runner drew. Only the edge is
// under review, which is what the live `agent.documents` run actually produces.
async function runnerDrewAnEdge(): Promise<{ src: string; dst: string; ref: string }> {
  const human = await session(HUMAN);
  const src = await note(human, "A note about the daemon");
  const dst = await note(human, "A note about the socket");
  const runner = await session(RUNNER);

  await link(runner, src, dst, RUNNER);

  return { src, dst, ref: edgeRef(src, dst, EdgeType.DOCUMENTS) };
}

function reviews(): ReviewService {
  return container.resolve(ReviewService);
}

async function pending(): Promise<Record<string, unknown>[]> {
  const result = (await pipeline().invoke(
    container,
    "list_reviews",
    {},
    { client: HUMAN, version: null },
  )) as { items: Record<string, unknown>[] };

  return result.items;
}

async function resolve(
  session_id: string,
  ref: string,
  decision: ReviewDecision,
  artifact = ReviewArtifact.EDGE,
): Promise<{ undone: boolean }> {
  return (await pipeline().invoke(
    container,
    "resolve_review",
    { session_id, artifact, ref, decision },
    { client: HUMAN, version: null },
  )) as { undone: boolean };
}

beforeEach(() => {
  env = setup();
  policy({ [RUNNER]: SUGGESTS });
});

describe("who is under review", () => {
  it("should list the principals config puts on suggest when the default is not", () => {
    // Given / When
    const scope = reviews().scope();

    // Then
    expect(scope).toEqual({ mode: "only", principals: [RUNNER] });
    expect(reviews().reviewsNobody()).toBe(false);
  });

  it("should invert to everyone-but when the DEFAULT posture is suggest", () => {
    // Given — no table of principals exists to enumerate, only the ones config names.
    policy({ trusted: profile({ write: Posture.AUTO }) }, profile({ write: Posture.SUGGEST }));

    // When / Then
    expect(reviews().scope()).toEqual({ mode: "except", principals: ["trusted"] });
  });

  it("should keep a named principal in scope when its own profile names no write posture", () => {
    // Given — an absent capability falls back to the default, which here is suggest.
    policy({ partial: profile({ read: Posture.AUTO }) }, profile({ write: Posture.SUGGEST }));

    // When / Then
    expect(reviews().scope().principals).not.toContain("partial");
  });

  it("should review nobody when no principal writes on suggest", () => {
    // Given
    policy({ [RUNNER]: profile({ write: Posture.AUTO }) });

    // When / Then
    expect(reviews().reviewsNobody()).toBe(true);
    expect(reviews().pending()).toEqual({ edges: 0, nodes: 0, total: 0 });
  });
});

describe("the review queue", () => {
  it("should surface an edge a suggest-posture principal drew, with both endpoints named", async () => {
    // Given
    const { src, dst, ref } = await runnerDrewAnEdge();

    // When
    const items = await pending();

    // Then
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      artifact: ReviewArtifact.EDGE,
      ref,
      principal: RUNNER,
      edge_type: EdgeType.DOCUMENTS,
      src: { id: src, title: "A note about the daemon" },
      dst: { id: dst, title: "A note about the socket" },
    });
  });

  it("should leave out what a principal at auto wrote", async () => {
    // Given — the same edge, drawn by a principal config does not put under review.
    const human = await session(HUMAN);
    const src = await note(human, "One");
    const dst = await note(human, "Two");

    await link(human, src, dst, HUMAN);

    // When / Then
    expect(await pending()).toEqual([]);
  });

  it("should count a node the runner wrote as well as an edge", async () => {
    // Given
    const runner = await session(RUNNER);

    await pipeline().invoke(
      container,
      "write_memory",
      {
        session_id: runner,
        parent_node_id: null,
        memory_kind: MemoryKind.SEMANTIC,
        type: "fact",
        title: "Something the runner concluded",
        content: "a durable fact with enough words in it to make a chunk worth keeping",
      },
      { client: RUNNER, version: null },
    );

    // When / Then
    expect(reviews().pending()).toMatchObject({ nodes: 1, total: 1 });
  });

  it("should leave out a system edge, which no agent authored", async () => {
    // Given
    const human = await session(HUMAN);
    const src = await note(human, "One");
    const dst = await note(human, "Two");

    env.edges.insertSystemSimilarityIfLive(src, dst, human, env.clock.now(), 0.9);

    // When / Then — provenance, not authorship, is what the queue filters on.
    expect(await pending()).toEqual([]);
  });

  it("should say who it is reviewing, so an empty queue is not mistaken for no queue", async () => {
    // Given / When
    const result = (await pipeline().invoke(
      container,
      "list_reviews",
      {},
      { client: HUMAN, version: null },
    )) as { reviewing: unknown; pending: unknown };

    // Then
    expect(result.reviewing).toEqual({ mode: "only", principals: [RUNNER] });
    expect(result.pending).toEqual({ edges: 0, nodes: 0 });
  });
});

describe("resolving a review", () => {
  it("should keep the edge live and drop it from the queue when it is kept", async () => {
    // Given
    const { ref } = await runnerDrewAnEdge();
    const human = await session(HUMAN);

    // When
    const result = await resolve(human, ref, ReviewDecision.KEPT);

    // Then
    expect(result.undone).toBe(false);
    expect(await pending()).toEqual([]);
    expect(
      env.db.prepare("SELECT COUNT(*) n FROM edges WHERE invalidated_at IS NULL").get(),
    ).toEqual({ n: 1 });
  });

  it("should retire the edge when it is undone", async () => {
    // Given
    const { ref } = await runnerDrewAnEdge();
    const human = await session(HUMAN);

    // When
    const result = await resolve(human, ref, ReviewDecision.UNDONE);

    // Then
    expect(result.undone).toBe(true);
    expect(await pending()).toEqual([]);
    expect(
      env.db.prepare("SELECT COUNT(*) n FROM edges WHERE invalidated_at IS NOT NULL").get(),
    ).toEqual({ n: 1 });
  });

  it("should invalidate the node when a node write is undone", async () => {
    // Given
    const runner = await session(RUNNER);
    const written = (await pipeline().invoke(
      container,
      "write_memory",
      {
        session_id: runner,
        parent_node_id: null,
        memory_kind: MemoryKind.SEMANTIC,
        type: "fact",
        title: "Something the runner concluded",
        content: "a durable fact with enough words in it to make a chunk worth keeping",
      },
      { client: RUNNER, version: null },
    )) as { envelope: { id: string } };
    const human = await session(HUMAN);

    // When
    const result = await resolve(
      human,
      written.envelope.id,
      ReviewDecision.UNDONE,
      ReviewArtifact.NODE,
    );

    // Then
    expect(result.undone).toBe(true);
    expect(env.nodes.referenceState(written.envelope.id)).toBe("invalidated");
  });

  it("should record the decision without moving a retirement someone else already made", async () => {
    // Given
    const { ref } = await runnerDrewAnEdge();
    const human = await session(HUMAN);

    await resolve(human, ref, ReviewDecision.UNDONE);

    // When — undoing the same edge twice must not report a second retirement.
    const again = await resolve(human, ref, ReviewDecision.UNDONE);

    // Then — the edge path is idempotent at the SQL level, so the row stays as it was.
    expect(again.undone).toBe(true);
    expect(env.db.prepare("SELECT COUNT(*) n FROM review_decisions").get()).toEqual({ n: 1 });
  });

  it("should let a decision be changed, keeping one row per artifact", async () => {
    // Given
    const { ref } = await runnerDrewAnEdge();
    const human = await session(HUMAN);

    await resolve(human, ref, ReviewDecision.KEPT);

    // When
    await resolve(human, ref, ReviewDecision.UNDONE);

    // Then
    expect(env.db.prepare("SELECT decision FROM review_decisions").all()).toEqual([
      { decision: ReviewDecision.UNDONE },
    ]);
  });

  it("should refuse a reference that is not an edge", async () => {
    // Given
    const human = await session(HUMAN);

    // When / Then
    await expect(resolve(human, "not-an-edge-ref", ReviewDecision.UNDONE)).rejects.toThrow(
      /expected src\|dst\|type/,
    );
  });

  it("should name the principal that decided, never the one that wrote", async () => {
    // Given
    const { ref } = await runnerDrewAnEdge();
    const human = await session(HUMAN);

    // When
    await resolve(human, ref, ReviewDecision.KEPT);

    // Then
    expect(env.db.prepare("SELECT decided_by FROM review_decisions").get()).toEqual({
      decided_by: HUMAN,
    });
  });
});

describe("who may review", () => {
  it("should cost the consolidate capability on both calls, which a writing agent does not carry", () => {
    // Given / When / Then — the runner's own profile sets consolidate: off, so it cannot
    // clear the queue its writes fill.
    expect(callCapability("list_reviews")).toBe(Capability.CONSOLIDATE);
    expect(callCapability("resolve_review")).toBe(Capability.CONSOLIDATE);
    expect(CALL_SURFACE.list_reviews.kind).toBe("read");
    expect(CALL_SURFACE.resolve_review.kind).toBe("write");
  });

  it("should deny the runner its own queue", async () => {
    // Given
    const runner = await session(RUNNER);

    // When / Then
    await expect(
      pipeline().invoke(
        container,
        "list_reviews",
        { session_id: runner },
        {
          client: RUNNER,
          version: null,
        },
      ),
    ).rejects.toThrow(/consolidate/);
  });
});
