import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { UpdateTool } from "@/presentation/mcp/tools/update";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup } from "@test/helpers";

const PARAGRAPH = "A durable fact stated at length, repeated to make the body long. ".repeat(20);

function sectioned(count: number): string {
  return Array.from({ length: count }, (_, i) => `## Part ${i + 1}\n${PARAGRAPH}`).join("\n\n");
}

interface Written {
  id: string;
  context_notes?: string[];
}

let session: string;

function write(title: string, content: string): Promise<Written> {
  return container.resolve(WriteTool).invoke({
    session_id: session,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title,
    content,
  });
}

beforeEach(async () => {
  setup();
  session = (await container.resolve(SessionStartTool).invoke({})).session_id;
});

describe("Long-body advisory", () => {
  it("should say nothing when the body is under the threshold", async () => {
    // Given / When
    const res = await write("Short", "One claim, briefly stated.");

    // Then
    expect(res.context_notes ?? []).toEqual([]);
  });

  it("should point at section-narrowing when a long body has headings", async () => {
    // Given / When
    const res = await write("Long and sectioned", sectioned(6));

    // Then
    expect(res.context_notes).toEqual([expect.stringContaining("sections")]);
    expect(res.context_notes![0]).toContain("6 sections");
  });

  it("should ask for headings when a long body has none to address", async () => {
    // Given / When
    const res = await write("Long and flat", PARAGRAPH.repeat(4));

    // Then
    expect(res.context_notes).toEqual([expect.stringContaining("add headings")]);
  });

  it("should never block the write it advises on", async () => {
    // Given / When
    const res = await write("Long and sectioned", sectioned(6));

    // Then
    expect(res.id).toBeTruthy();
  });

  it("should advise on a revision that leaves the body long", async () => {
    // Given
    const node = await write("Short", "One claim, briefly stated.");

    // When
    const revised = (await container.resolve(UpdateTool).invoke({
      session_id: session,
      id: node.id,
      content: sectioned(6),
      reason: "grew into an index",
    })) as Written;

    // Then
    expect(revised.context_notes).toEqual([expect.stringContaining("sections")]);
  });

  it("should say nothing on a revision that only changes the title", async () => {
    // Given
    const node = await write("Long and sectioned", sectioned(6));

    // When
    const revised = (await container.resolve(UpdateTool).invoke({
      session_id: session,
      id: node.id,
      title: "Renamed",
    })) as Written;

    // Then
    expect(revised.context_notes).toBeUndefined();
  });

  it("should be disabled by a zero threshold", async () => {
    // Given
    setup();
    process.env.MEMORY_LONG_BODY_CHARS = "0";
    session = (await container.resolve(SessionStartTool).invoke({})).session_id;

    // When
    const res = await write("Long and sectioned", sectioned(6));

    // Then
    expect(res.context_notes ?? []).toEqual([]);
    delete process.env.MEMORY_LONG_BODY_CHARS;
  });
});
