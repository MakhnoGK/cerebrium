import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import type { Envelope, NodeSection } from "@/db/repo";
import { PREAMBLE_SECTION } from "@/core/chunk";
import { MemoryKind } from "@/core/vocab";
import { GetTool } from "@/presentation/mcp/tools/get";
import { SearchTool, type SearchResult } from "@/presentation/mcp/tools/search";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { UpdateTool } from "@/presentation/mcp/tools/update";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup, type TestEnv } from "@test/helpers";

const BODY = [
  "Ranking has always been chunk level, and now delivery is too.",
  "",
  "## Ranking",
  "Hybrid fusion blends bm25 with vector similarity.",
  "",
  "### Decay",
  "Episodic memories decay by disuse rather than by wall clock.",
  "",
  "## Storage",
  "One SQLite file holds every node, chunk and edge.",
].join("\n");

interface GetNode {
  content?: string;
  outline?: NodeSection[];
  source?: string;
}

let env: TestEnv;
let session: string;

function write(title: string, content: string): Promise<Envelope> {
  return container.resolve(WriteTool).invoke({
    session_id: session,
    parent_node_id: null,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title,
    content,
  });
}

async function get(
  ids: string[],
  extra: { sections?: string[]; outline?: boolean; rev?: number; as_of?: string } = {},
): Promise<GetNode[]> {
  const res = await container.resolve(GetTool).invoke({ session_id: session, ids, ...extra });

  return res.nodes as GetNode[];
}

beforeEach(async () => {
  env = setup();
  session = (await container.resolve(SessionStartTool).invoke({})).session_id;
});

describe("ChunksRepo.sections", () => {
  it("should list one entry per heading path in body order when a node has headings", async () => {
    // Given
    const node = await write("Ranking model", BODY);

    // When
    const outline = env.chunks.sections(node.id);

    // Then
    expect(outline.map((s) => s.section)).toEqual([
      PREAMBLE_SECTION,
      "H2: Ranking",
      "H2: Ranking > H3: Decay",
      "H2: Storage",
    ]);
    expect(outline.every((s) => s.chars > 0)).toBe(true);
  });

  it("should fold a heading that recurs later in the body into its first entry", async () => {
    // Given
    const node = await write(
      "Recurring heading",
      ["## Notes", "first pass", "", "## Other", "unrelated", "", "## Notes", "second pass"].join(
        "\n",
      ),
    );

    // When
    const outline = env.chunks.sections(node.id);
    const notes = outline.filter((s) => s.section === "H2: Notes");

    // Then
    expect(notes).toHaveLength(1);
    expect(notes[0]!.chars).toBeGreaterThan("## Notes\nfirst pass".length);
  });

  it("should report no sections when the node has no live chunks", () => {
    // Given / When
    const outline = env.chunks.sections("01JZZZZZZZZZZZZZZZZZZZZZZZ");

    // Then
    expect(outline).toEqual([]);
  });
});

describe("Section-narrowed get", () => {
  it("should return only the named section when `sections` is given", async () => {
    // Given
    const node = await write("Ranking model", BODY);

    // When
    const [narrowed] = await get([node.id], { sections: ["H2: Storage"] });

    // Then
    expect(narrowed!.content).toContain("One SQLite file");
    expect(narrowed!.content).not.toContain("Hybrid fusion");
    expect(narrowed!.content!.length).toBeLessThan(BODY.length);
  });

  it("should address the whole subtree when the request names a parent heading", async () => {
    // Given
    const node = await write("Ranking model", BODY);

    // When
    const [narrowed] = await get([node.id], { sections: ["H2: Ranking"] });

    // Then
    expect(narrowed!.content).toContain("Hybrid fusion");
    expect(narrowed!.content).toContain("decay by disuse");
    expect(narrowed!.content).not.toContain("One SQLite file");
  });

  it("should address the text before the first heading when the request names the preamble", async () => {
    // Given
    const node = await write("Ranking model", BODY);

    // When
    const [narrowed] = await get([node.id], { sections: [PREAMBLE_SECTION] });

    // Then
    expect(narrowed!.content).toContain("delivery is too");
    expect(narrowed!.content).not.toContain("## Ranking");
  });

  it("should return the full outline alongside a narrowed body so nothing is silently withheld", async () => {
    // Given
    const node = await write("Ranking model", BODY);

    // When
    const [narrowed] = await get([node.id], { sections: ["H2: Storage"] });

    // Then
    expect(narrowed!.outline!.map((s) => s.section)).toContain("H2: Ranking");
    expect(narrowed!.outline).toHaveLength(4);
  });

  it("should return an outline and no body at all when `outline` is true", async () => {
    // Given
    const node = await write("Ranking model", BODY);

    // When
    const [outlined] = await get([node.id], { outline: true });

    // Then
    expect(outlined!.content).toBeUndefined();
    expect(outlined!.source).toBeUndefined();
    expect(outlined!.outline).toHaveLength(4);
  });

  it("should outline every id when `outline` is true for several nodes", async () => {
    // Given
    const first = await write("Ranking model", BODY);
    const second = await write("Storage model", "## Files\nOne SQLite file.");

    // When
    const nodes = await get([first.id, second.id], { outline: true });

    // Then
    expect(nodes).toHaveLength(2);
    expect(nodes.every((n) => n.outline !== undefined && n.content === undefined)).toBe(true);
  });

  it("should fail with the names the node does have when a section does not exist", async () => {
    // Given
    const node = await write("Ranking model", BODY);

    // When / Then
    await expect(get([node.id], { sections: ["H2: Consolidation"] })).rejects.toThrow(
      /no section named "H2: Consolidation".*H2: Storage/s,
    );
  });

  it("should reject `sections` when more than one id is requested", async () => {
    // Given
    const first = await write("Ranking model", BODY);
    const second = await write("Storage model", "## Files\nOne SQLite file.");

    // When / Then
    await expect(get([first.id, second.id], { sections: ["H2: Storage"] })).rejects.toThrow(
      /exactly one element/,
    );
  });

  it("should reject narrowing a past revision, which has no live chunks", async () => {
    // Given
    const node = await write("Ranking model", BODY);
    await container.resolve(UpdateTool).invoke({
      session_id: session,
      id: node.id,
      content: "## Ranking\nRewritten.",
      reason: "rewrite",
    });

    // When / Then
    await expect(get([node.id], { sections: ["H2: Ranking"], rev: 1 })).rejects.toThrow(
      /current revision's chunks/,
    );
    await expect(get([node.id], { outline: true, as_of: env.clock.t })).rejects.toThrow(
      /current revision's chunks/,
    );
  });

  it("should address the rewritten body after an update, not the superseded one", async () => {
    // Given
    const node = await write("Ranking model", BODY);
    await container.resolve(UpdateTool).invoke({
      session_id: session,
      id: node.id,
      content: [
        "## Ranking",
        "Rewritten in full.",
        "",
        "## Consolidation",
        "Runs in the daemon.",
      ].join("\n"),
      reason: "rewrite",
    });

    // When
    const [outlined] = await get([node.id], { outline: true });
    const [narrowed] = await get([node.id], { sections: ["H2: Consolidation"] });

    // Then
    expect(outlined!.outline!.map((s) => s.section)).toEqual(["H2: Ranking", "H2: Consolidation"]);
    expect(narrowed!.content).toContain("Runs in the daemon");
    await expect(get([node.id], { sections: ["H2: Storage"] })).rejects.toThrow(/no section named/);
  });

  it("should return the whole body when neither `sections` nor `outline` is given", async () => {
    // Given
    const node = await write("Ranking model", BODY);

    // When
    const [whole] = await get([node.id]);

    // Then
    expect(whole!.content).toBe(BODY);
    expect(whole!.outline).toBeUndefined();
  });
});

describe("Search section addressing", () => {
  const HEADED = [
    "Opening remarks that name nothing in particular.",
    "",
    "## Ranking",
    "Reciprocal rank fusion blends bm25 scores with cosine similarity.",
    "",
    "## Storage",
    "Litestream replicates the sqlite file to object storage continuously.",
  ].join("\n");

  async function search(query: string): Promise<SearchResult[]> {
    const res = await container
      .resolve(SearchTool)
      .invoke({ session_id: session, query, limit: 10 });

    return res.results;
  }

  it("should name the section of the matched chunk when the hit sits under a heading", async () => {
    // Given
    const node = await write("Architecture", HEADED);
    await env.worker.tick();

    // When
    const hit = (await search("litestream replicates object storage")).find(
      (r) => r.id === node.id,
    );

    // Then
    expect(hit!.best_chunk).toContain("Litestream");
    expect(hit!.section).toBe("H2: Storage");
  });

  it("should feed straight back into a narrowed get when a search names a section", async () => {
    // Given
    const node = await write("Architecture", HEADED);
    await env.worker.tick();
    const hit = (await search("litestream replicates object storage")).find(
      (r) => r.id === node.id,
    );

    // When
    const [narrowed] = await get([node.id], { sections: [hit!.section!] });

    // Then
    expect(narrowed!.content).toContain("Litestream");
    expect(narrowed!.content).not.toContain("Reciprocal rank fusion");
  });

  it("should drop the summary when best_chunk already carries the same text", async () => {
    // Given
    const node = await write(
      "Flat note",
      "Litestream replicates the sqlite file to object storage.",
    );
    await env.worker.tick();

    // When
    const hit = (await search("litestream replicates object storage")).find(
      (r) => r.id === node.id,
    );

    // Then
    expect(hit!.best_chunk).toContain("Litestream");
    expect(hit!.summary).toBeUndefined();
  });

  it("should keep the summary when best_chunk carries different text", async () => {
    // Given
    const node = await write("Architecture", HEADED);
    await env.worker.tick();

    // When
    const hit = (await search("litestream replicates object storage")).find(
      (r) => r.id === node.id,
    );

    // Then
    expect(hit!.best_chunk).toContain("Litestream");
    expect(hit!.summary).toContain("Opening remarks");
  });

  it("should name no section when the matched chunk precedes the first heading", async () => {
    // Given
    const node = await write(
      "Flat note",
      "Litestream replicates the sqlite file to object storage.",
    );
    await env.worker.tick();

    // When
    const hit = (await search("litestream replicates object storage")).find(
      (r) => r.id === node.id,
    );

    // Then
    expect(hit!.best_chunk).toBeDefined();
    expect(hit!.section).toBeUndefined();
  });
});
