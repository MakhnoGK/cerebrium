import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SessionStartTool } from "../src/tools/session_start";
import { CodeIndexTool } from "../src/tools/code_index";
import { CodeLookupTool } from "../src/tools/code_lookup";
import { GetTool } from "../src/tools/get";
import { WriteTool } from "../src/tools/write";
import { UpdateTool } from "../src/tools/update";
import { makeCtx } from "./helpers";

const session_start = new SessionStartTool();
const code_index = new CodeIndexTool();
const code_lookup = new CodeLookupTool();
const get = new GetTool();
const write = new WriteTool();
const update = new UpdateTool();

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/demo-repo");

async function indexed() {
  const t = makeCtx();
  const s = await session_start.invoke(t.ctx, {});
  const stats = (await code_index.invoke(t.ctx, { session_id: s.session_id, path: FIXTURE })) as {
    files_indexed: number;
    symbols_added: number;
    repo: string;
  };
  return { ...t, session_id: s.session_id, stats };
}

describe("code_index tool", () => {
  it("indexes an explicit path and returns a compact summary envelope", async () => {
    const { stats } = await indexed();
    expect(stats.repo).toBe("demo-repo");
    expect(stats.files_indexed).toBe(2);
    expect(stats.symbols_added).toBeGreaterThan(4);
    // Envelope, not per-symbol dumps.
    expect(Object.keys(stats)).not.toContain("symbols");
  });

  it("errors actionably when repo is unknown and no path given", async () => {
    const { ctx, session_id } = await indexed();
    await expect(code_index.invoke(ctx, { session_id, repo: "nope" })).rejects.toThrow(
      /not configured/,
    );
  });
});

describe("code_lookup tool", () => {
  it("resolves by name with neighbor stubs", async () => {
    const { ctx, session_id } = await indexed();
    const res = (await code_lookup.invoke(ctx, {
      session_id,
      name: "AuthService",
      limit: 10,
    })) as {
      symbols: {
        title: string;
        symbol_kind: string;
        neighbors: { edge: string; title: string }[];
      }[];
    };
    expect(res.symbols).toHaveLength(1);
    expect(res.symbols[0]!.symbol_kind).toBe("class");
    expect(
      res.symbols[0]!.neighbors.some((n) => n.edge === "defines" && n.title.endsWith("validate")),
    ).toBe(true);
  });

  it("lists a file's symbols", async () => {
    const { ctx, session_id } = await indexed();
    const res = (await code_lookup.invoke(ctx, {
      session_id,
      file: "util/crypto.ts",
      limit: 10,
    })) as {
      symbols: { symbol_kind: string; title: string }[];
    };
    const kinds = res.symbols.map((s) => s.symbol_kind).sort();
    expect(kinds).toContain("function");
    expect(kinds).toContain("enum");
  });

  it("requires name or file", async () => {
    const { ctx, session_id } = await indexed();
    await expect(code_lookup.invoke(ctx, { session_id, limit: 10 })).rejects.toThrow(/provide/);
  });
});

describe("get on a symbol", () => {
  it("returns the raw source slice + structured facets", async () => {
    const { ctx, session_id } = await indexed();
    const found = ctx.repo.findSymbolsByName("AuthService", undefined, 1);
    const id = found[0]!.envelope.id;
    const res = (await get.invoke(ctx, { session_id, ids: [id] })) as {
      nodes: { source: string; symbol: { signature: string; symbol_kind: string; path: string } }[];
    };
    expect(res.nodes[0]!.source).toContain("class AuthService");
    expect(res.nodes[0]!.symbol.symbol_kind).toBe("class");
    expect(res.nodes[0]!.symbol.signature).toContain("class AuthService");
  });
});

describe("mirror discipline", () => {
  it("write with memory_kind:'mirror' is rejected", async () => {
    const { ctx, session_id } = await indexed();
    await expect(
      write.invoke(ctx, {
        session_id,
        memory_kind: "mirror",
        type: "symbol",
        title: "x",
        content: "y",
      }),
    ).rejects.toThrow(/indexer|code_index/);
  });

  it("update on a symbol node is rejected with an actionable message", async () => {
    const { ctx, session_id } = await indexed();
    const id = ctx.repo.findSymbolsByName("AuthService", undefined, 1)[0]!.envelope.id;
    await expect(update.invoke(ctx, { session_id, id, content: "hand edit" })).rejects.toThrow(
      /re-indexed|code_index/,
    );
  });
});
