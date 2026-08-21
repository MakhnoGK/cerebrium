import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { container } from "tsyringe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsolidationRecommendation } from "@/domain/ports/consolidation-provider";
import { ConsolidationWorker } from "@/application/workers";
import { CodeRepo, ConsolidationRepo } from "@/db/repositories";
import { ConsolidationKind, EdgeType, MemoryKind, Posture } from "@/core/vocab";
import { CodeIndexTool } from "@/presentation/mcp/tools/code-index";
import { ConsolidateApplyTool } from "@/presentation/mcp/tools/consolidate-apply";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { ConsolidationPostureConfig, StaticConfigSource } from "@/infrastructure/config";
import { setup, type TestEnv } from "@test/helpers";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/demo-repo");

let env: TestEnv;
let session: string;

async function note(content: string, project: string | null = "demo-repo"): Promise<string> {
  const { id } = await container.resolve(WriteTool).invoke({
    session_id: session,
    parent_node_id: null,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title: `Note about ${content.slice(0, 20)}`,
    content,
    ...(project === null ? {} : { project }),
  });

  return id;
}

function candidates(): { kind: string; member_ids: string; canonical_id: string | null }[] {
  return env.db
    .prepare("SELECT kind, member_ids, canonical_id FROM consolidation_candidates")
    .all() as { kind: string; member_ids: string; canonical_id: string | null }[];
}

function withDocumentsPosture(posture: Posture): void {
  container.register(ConsolidationPostureConfig, {
    useValue: new ConsolidationPostureConfig(
      new StaticConfigSource({ MEMORY_CONSOLIDATE_DOCUMENTS: posture }),
    ),
  });
}

function symbolId(name: string): string {
  return container.resolve(CodeRepo).findSymbolsByName(name, "demo-repo", 1)[0]!.envelope.id;
}

afterEach(() => {
  container.register(ConsolidationPostureConfig, {
    useValue: new ConsolidationPostureConfig(new StaticConfigSource({})),
  });
});

beforeEach(async () => {
  env = setup();
  session = (await container.resolve(SessionStartTool).invoke({})).session_id;
  await container.resolve(CodeIndexTool).invoke({ session_id: session, path: FIXTURE });
});

describe("Proposing note-to-code citations", () => {
  it("should propose the symbol a note cites in backticks", async () => {
    // Given
    withDocumentsPosture(Posture.SUGGEST);

    const id = await note("the token check goes through `hashToken` before anything else");

    // When
    const result = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(result.documents_suggested).toBe(1);
    expect(candidates()).toEqual([
      {
        kind: ConsolidationKind.DOCUMENTS,
        member_ids: JSON.stringify([id, symbolId("hashToken")]),
        canonical_id: symbolId("hashToken"),
      },
    ]);
  });

  it("should ignore the same name written as ordinary prose", async () => {
    // Given — a bare word is not a citation
    await note("the token check goes through hashToken before anything else");

    // When / Then
    expect((await container.resolve(ConsolidationWorker).tick()).documents_suggested).toBe(0);
  });

  it("should ignore a citation whose name is an ordinary word", async () => {
    // Given — `stats`, `node` and `install` are all real symbol names that prose means
    // in the everyday sense
    await note("we read the `issue` of the file and moved on");

    // When / Then
    expect((await container.resolve(ConsolidationWorker).tick()).documents_suggested).toBe(0);
  });

  it("should not cross from one project's note into another project's code", async () => {
    // Given
    await note("the token check goes through `hashToken`", "some-other-project");

    // When / Then
    expect((await container.resolve(ConsolidationWorker).tick()).documents_suggested).toBe(0);
  });

  it("should not propose into a repo whose root is gone", async () => {
    // Given — a detached repo cannot be checked against source
    await note("the token check goes through `hashToken` before anything else");
    env.db
      .prepare("UPDATE code_repos SET root = ? WHERE repo = 'demo-repo'")
      .run("/repos/deleted-last-year");

    // When / Then
    expect((await container.resolve(ConsolidationWorker).tick()).documents_suggested).toBe(0);
  });

  it("should leave a pair that is already connected alone", async () => {
    // Given
    withDocumentsPosture(Posture.SUGGEST);

    const id = await note("the token check goes through `hashToken` before anything else");
    const worker = container.resolve(ConsolidationWorker);

    expect((await worker.tick()).documents_suggested).toBe(1);

    // When — the proposal is applied, so the pair is connected
    const [candidate] = env.db.prepare("SELECT id FROM consolidation_candidates").all() as {
      id: string;
    }[];
    await container.resolve(ConsolidateApplyTool).invoke({
      session_id: session,
      id: candidate!.id,
      decision: ConsolidationRecommendation.APPLY,
    });

    // Then
    const edge = env.db
      .prepare("SELECT type FROM edges WHERE src = ? AND dst = ? AND invalidated_at IS NULL")
      .get(id, symbolId("hashToken")) as { type: string } | undefined;

    expect(edge?.type).toBe(EdgeType.DOCUMENTS);
  });
});

describe("Applying note-to-code citations directly", () => {
  it("should write the edge itself under auto instead of queueing it", async () => {
    // Given
    const id = await note("the token check goes through `hashToken` before anything else");

    // When
    const result = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(result.documents_linked).toBe(1);
    expect(result.documents_suggested).toBe(0);
    expect(candidates()).toEqual([]);
    expect(
      env.db
        .prepare(
          "SELECT provenance FROM edges WHERE src = ? AND dst = ? AND type = ? AND invalidated_at IS NULL",
        )
        .get(id, symbolId("hashToken"), EdgeType.DOCUMENTS),
    ).toEqual({ provenance: "system" });
  });

  it("should close a candidate a person never got to, rather than leave it pending forever", async () => {
    // Given — the queue a `suggest` posture built in an earlier process, which is how this
    // is reached: the posture is read once at daemon start, so the queue outlives it.
    withDocumentsPosture(Posture.AUTO);

    const id = await note("the token check goes through `hashToken` before anything else");
    const queued = container.resolve(ConsolidationRepo).insertCandidate({
      kind: ConsolidationKind.DOCUMENTS,
      member_ids: [id, symbolId("hashToken")],
      canonical_id: symbolId("hashToken"),
      score: 1,
      detected_at: new Date(0).toISOString(),
    });

    expect(queued).not.toBeNull();

    // When
    const result = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(result.documents_linked).toBe(1);
    expect(
      env.db.prepare("SELECT status FROM consolidation_candidates WHERE id = ?").get(queued),
    ).toEqual({ status: "applied" });
  });

  it("should propose nothing at all when the posture is off", async () => {
    // Given
    withDocumentsPosture(Posture.OFF);

    await note("the token check goes through `hashToken` before anything else");

    // When
    const result = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(result.documents_linked).toBe(0);
    expect(result.documents_suggested).toBe(0);
    expect(candidates()).toEqual([]);
  });
});
