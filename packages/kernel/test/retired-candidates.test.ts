import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { ConsolidationKind, MemoryKind } from "@cerebrium/contracts/vocab";
import {
  CONSOLIDATION_REPO_TOKEN,
  NODES_REPO_TOKEN,
  type ConsolidationRepo,
  type NodesRepo,
} from "@/domain/ports/storage";
import { ConsolidationWorker } from "@/application/workers";
import { setup } from "@test/helpers";

const TS = "2026-01-01T00:00:00.000Z";

async function note(title: string): Promise<string> {
  return (
    await container.resolve<NodesRepo>(NODES_REPO_TOKEN).createNode({
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title,
      content: `${title} body`,
      project: "p",
      session_id: "s",
      ts: TS,
    })
  ).id;
}

describe("Candidates whose members were retired", () => {
  it("should be dismissed by the next sweep, leaving the others pending", async () => {
    // Given
    setup();
    const repo = container.resolve<ConsolidationRepo>(CONSOLIDATION_REPO_TOKEN);
    const [a, b, c, d] = [await note("A"), await note("B"), await note("C"), await note("D")];
    const stale = await repo.insertCandidate({
      kind: ConsolidationKind.MERGE,
      member_ids: [a, b],
      canonical_id: a,
      score: 0.95,
      detected_at: TS,
    });
    const live = await repo.insertCandidate({
      kind: ConsolidationKind.MERGE,
      member_ids: [c, d],
      canonical_id: c,
      score: 0.95,
      detected_at: TS,
    });
    await container
      .resolve<NodesRepo>(NODES_REPO_TOKEN)
      .invalidateNode(b, { ts: TS, session_id: "s" });

    // When
    await container.resolve(ConsolidationWorker).tick();

    // Then
    expect((await repo.getCandidate(stale!))?.status).toBe("dismissed");
    expect((await repo.getCandidate(live!))?.status).toBe("pending");
  });
});
