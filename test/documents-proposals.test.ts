import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { ConsolidationRecommendation } from "@/domain/ports/consolidation-provider";
import { ConsolidationWorker } from "@/application/workers";
import { CodeRepo } from "@/db/repositories";
import { ConsolidationKind, EdgeType, MemoryKind } from "@/core/vocab";
import { CodeIndexTool } from "@/presentation/mcp/tools/code-index";
import { ConsolidateApplyTool } from "@/presentation/mcp/tools/consolidate-apply";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
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

function symbolId(name: string): string {
  return container.resolve(CodeRepo).findSymbolsByName(name, "demo-repo", 1)[0]!.envelope.id;
}

beforeEach(async () => {
  env = setup();
  session = (await container.resolve(SessionStartTool).invoke({})).session_id;
  await container.resolve(CodeIndexTool).invoke({ session_id: session, path: FIXTURE });
});

describe("Proposing note-to-code citations", () => {
  it("should propose the symbol a note cites in backticks", async () => {
    // Given
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
