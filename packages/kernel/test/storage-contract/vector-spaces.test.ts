import type { DependencyContainer } from "tsyringe";
import { beforeEach, expect, it } from "vitest";
import { MemoryKind } from "@cerebrium/contracts/vocab";
import {
  NODES_REPO_TOKEN,
  VECTOR_SPACES_REPO_TOKEN,
  type NodesRepo,
  type VectorSpacesRepo,
} from "@/domain/ports/storage";
import { describeStorage } from "@test/storage-contract/backends";

const T0 = "2026-01-01T00:00:00.000Z";
const MODEL = "Xenova/bge-m3";

function unit(dim: number, at: number): number[] {
  return Array.from({ length: dim }, (_, i) => (i === at ? 1 : 0));
}

describeStorage("vector spaces", (backend) => {
  let scope: DependencyContainer;
  let spaces: VectorSpacesRepo;

  beforeEach(() => {
    scope = backend.fresh();
    spaces = scope.resolve<VectorSpacesRepo>(VECTOR_SPACES_REPO_TOKEN);
  });

  const note = async (title: string) =>
    (
      await scope.resolve<NodesRepo>(NODES_REPO_TOKEN).createNode({
        memory_kind: MemoryKind.SEMANTIC,
        type: "fact",
        title,
        content: `# ${title}\n\n${title} opens the body.`,
        project: "p",
        session_id: "s",
        ts: T0,
      })
    ).id;

  if (backend.name === "sqlite") {
    it("should refuse every call", async () => {
      await expect(spaces.ensureSpace(MODEL, 1024, T0)).rejects.toThrow(/sqlite/);
    });

    return;
  }

  it("should add an inactive space for a new model and return it again", async () => {
    // When
    const created = await spaces.ensureSpace(MODEL, 1024, T0);
    const again = await spaces.ensureSpace(MODEL, 1024, T0);

    // Then
    expect(created).toMatchObject({ id: 2, model: MODEL, dim: 1024, active: false });
    expect(again.id).toBe(created.id);
    await expect(spaces.ensureSpace(MODEL, 768, T0)).rejects.toThrow(/1024-d/);
  });

  it("should fill a space chunk by chunk and refuse a vector of the wrong size", async () => {
    // Given
    await note("Alpha");
    const space = await spaces.ensureSpace(MODEL, 4, T0);
    const pending = await spaces.unembeddedChunks(space.id, 10);

    // When
    await spaces.putChunkVectors(
      space.id,
      pending.map((c, i) => ({ chunkId: c.id, vector: unit(4, i % 4) })),
      "1",
      T0,
    );

    // Then
    expect(pending.length).toBeGreaterThan(0);
    expect(await spaces.unembeddedChunks(space.id, 10)).toEqual([]);
    expect(await spaces.coverage(space.id)).toEqual({
      chunks: pending.length,
      embedded: pending.length,
    });
    await expect(
      spaces.putChunkVectors(space.id, [{ chunkId: pending[0]!.id, vector: unit(3, 0) }], "1", T0),
    ).rejects.toThrow(/does not fit/);
  });

  it("should make exactly one space active", async () => {
    // Given
    const space = await spaces.ensureSpace(MODEL, 1024, T0);

    // When
    await spaces.activate(space.id);

    // Then
    expect((await spaces.spaces()).map((s) => [s.id, s.active])).toEqual([
      [1, false],
      [space.id, true],
    ]);
  });
});
