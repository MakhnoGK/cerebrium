import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { MemoryKind } from "@/core/vocab";
import { CodeIndexTool } from "@/tools/code-index";
import { CodeLookupTool } from "@/tools/code-lookup";
import { GetTool } from "@/tools/get";
import { SessionStartTool } from "@/tools/session-start";
import { UpdateTool } from "@/tools/update";
import { WriteTool } from "@/tools/write";
import { setup, TestEnv } from "@test/helpers";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/demo-repo");

async function indexed(): Promise<{
  env: TestEnv;
  session_id: string;
  stats: { files_indexed: number; symbols_added: number; repo: string };
}> {
  const env = setup();
  const session_id = (await container.resolve(SessionStartTool).invoke({})).session_id;
  const stats = (await container.resolve(CodeIndexTool).invoke({ session_id, path: FIXTURE })) as {
    files_indexed: number;
    symbols_added: number;
    repo: string;
  };
  return { env, session_id, stats };
}

describe("CodeIndexTool", () => {
  it("should index an explicit path and return a compact summary envelope", async () => {
    // Given / When
    const { stats } = await indexed();

    // Then
    expect(stats.repo).toBe("demo-repo");
    expect(stats.files_indexed).toBe(2);
    expect(stats.symbols_added).toBeGreaterThan(4);
    expect(Object.keys(stats)).not.toContain("symbols"); // envelope, not per-symbol dumps
  });

  it("should throw actionably when the repo is unknown and no path is given", async () => {
    // Given
    const { session_id } = await indexed();

    // When / Then
    await expect(
      container.resolve(CodeIndexTool).invoke({ session_id, repo: "nope" }),
    ).rejects.toThrow(/not configured/);
  });
});

describe("CodeLookupTool", () => {
  it("should resolve a symbol by name with neighbor stubs", async () => {
    // Given
    const { session_id } = await indexed();

    // When
    const res = (await container
      .resolve(CodeLookupTool)
      .invoke({ session_id, name: "AuthService", limit: 10 })) as {
      symbols: {
        title: string;
        symbol_kind: string;
        neighbors: { edge: string; title: string }[];
      }[];
    };

    // Then
    expect(res.symbols).toHaveLength(1);
    expect(res.symbols[0]!.symbol_kind).toBe("class");
    expect(
      res.symbols[0]!.neighbors.some((n) => n.edge === "defines" && n.title.endsWith("validate")),
    ).toBe(true);
  });

  it("should list a file's symbols when given a file path", async () => {
    // Given
    const { session_id } = await indexed();

    // When
    const res = (await container
      .resolve(CodeLookupTool)
      .invoke({ session_id, file: "util/crypto.ts", limit: 10 })) as {
      symbols: { symbol_kind: string; title: string }[];
    };

    // Then
    const kinds = res.symbols.map((s) => s.symbol_kind).sort();
    expect(kinds).toContain("function");
    expect(kinds).toContain("enum");
  });

  it("should require name or file", async () => {
    // Given
    const { session_id } = await indexed();

    // When / Then
    await expect(
      container.resolve(CodeLookupTool).invoke({ session_id, limit: 10 }),
    ).rejects.toThrow(/provide/);
  });
});

describe("GetTool on a symbol", () => {
  it("should return the raw source slice and structured facets", async () => {
    // Given
    const { env, session_id } = await indexed();
    const id = env.code.findSymbolsByName("AuthService", undefined, 1)[0]!.envelope.id;

    // When
    const res = (await container.resolve(GetTool).invoke({ session_id, ids: [id] })) as {
      nodes: { source: string; symbol: { signature: string; symbol_kind: string; path: string } }[];
    };

    // Then
    expect(res.nodes[0]!.source).toContain("class AuthService");
    expect(res.nodes[0]!.symbol.symbol_kind).toBe("class");
    expect(res.nodes[0]!.symbol.signature).toContain("class AuthService");
  });
});

describe("Mirror discipline", () => {
  it("should reject a write with memory_kind:'mirror'", async () => {
    // Given
    const { session_id } = await indexed();

    // When / Then
    await expect(
      container.resolve(WriteTool).invoke({
        session_id,
        memory_kind: MemoryKind.MIRROR,
        type: "symbol",
        title: "x",
        content: "y",
      }),
    ).rejects.toThrow(/indexer|code_index/);
  });

  it("should reject an update on a symbol node with an actionable message", async () => {
    // Given
    const { env, session_id } = await indexed();
    const id = env.code.findSymbolsByName("AuthService", undefined, 1)[0]!.envelope.id;

    // When / Then
    await expect(
      container.resolve(UpdateTool).invoke({ session_id, id, content: "hand edit" }),
    ).rejects.toThrow(/re-indexed|code_index/);
  });
});
