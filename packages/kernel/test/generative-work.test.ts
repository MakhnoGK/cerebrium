import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { ConsolidationWorker } from "@/application/workers";
import { setup } from "@test/helpers";

describe("Generative work left", () => {
  it("should report none when no provider generates", async () => {
    // Given
    setup();

    // When
    const left = await container.resolve(ConsolidationWorker).hasGenerativeWork();

    // Then
    expect(left).toBe(false);
  });
});
