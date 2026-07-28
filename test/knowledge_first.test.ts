import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCtx } from "@test/helpers";
import type { Ctx } from "@/tools/context";
import type { Envelope } from "@/db/repo";
import { SessionStartTool } from "../src/tools/session-start";
import { CodeIndexTool } from "../src/tools/code-index";
import { SearchTool } from "../src/tools/search";
import { WriteTool } from "../src/tools/write";

const DEPLOY = `/**
 * deploy pipeline deploy pipeline
 */
export function deployPipeline(): void {}
`;

let root: string;

function ids(res: Awaited<ReturnType<typeof search.invoke>>): string[] {
  return res.results.map((e) => e.id);
}

// A three-node corpus for "deploy pipeline": a strong fact (title match on both terms),
// a code symbol (body match only — its qualified name is one camelCase token), and a weak
// fact (one term). Raw order is [strong, symbol, weak]. The symbol weight moves the symbol
// within that fixed frame, so its rank shift isolates the knowledge-first behavior.
async function corpus(
  ctx: Ctx,
): Promise<{ s: string; strong: string; symbol: string; weak: string }> {
  const s = (await session_start.invoke(ctx, {})).session_id;
  const stats = (await code_index.invoke(ctx, { session_id: s, path: root })) as { repo: string };
  const symbol = ctx.repo.findSymbolsByName("deployPipeline", stats.repo, 1)[0]!.envelope.id;
  const strong = (
    (await write.invoke(ctx, {
      session_id: s,
      memory_kind: "semantic",
      type: "fact",
      title: "Deploy pipeline",
      content: "deploy pipeline release runbook steps",
    })) as Envelope
  ).id;
  const weak = (
    (await write.invoke(ctx, {
      session_id: s,
      memory_kind: "semantic",
      type: "fact",
      title: "Notebook",
      content: "the deploy step only",
    })) as Envelope
  ).id;

  return { s, strong, symbol, weak };
}

let sessionStartTool: SessionStartTool;
let writeTool: WriteTool;
let codeIndexTool: CodeIndexTool;
let searchTool: SearchTool;

beforeAll(() => {
  writeTool = container.resolve(WriteTool);
  codeIndexTool = container.resolve(CodeIndexTool);
  searchTool = container.resolve(SearchTool);
  sessionStartTool = container.resolve(SessionStartTool);
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mk-kf-"));
  mkdirSync(join(root, "svc"), { recursive: true });
  writeFileSync(join(root, "svc", "deploy.ts"), DEPLOY);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.MEMORY_SYMBOL_WEIGHT;
});

describe("knowledge-first ranking", () => {
  it("down-weights code symbols by default so authored knowledge ranks first", async () => {
    const { ctx } = makeCtx();
    const { s, strong, symbol } = await corpus(ctx);
    const def = ids(
      await search.invoke(ctx, {
        session_id: s,
        query: "deploy pipeline",
        mode: "text",
        limit: 10,
      }),
    );

    expect(def).toContain(symbol);
    expect(def.indexOf(strong)).toBeLessThan(def.indexOf(symbol)); // authored above code
  });

  it("the symbol weight is configurable and monotonic", async () => {
    const { ctx } = makeCtx();
    const { s, symbol } = await corpus(ctx);

    process.env.MEMORY_SYMBOL_WEIGHT = "0.01"; // heavy penalty -> symbol sinks to the bottom

    const low = ids(
      await search.invoke(ctx, {
        session_id: s,
        query: "deploy pipeline",
        mode: "text",
        limit: 10,
      }),
    );
    expect(low[low.length - 1]).toBe(symbol);

    process.env.MEMORY_SYMBOL_WEIGHT = "100"; // heavy boost -> symbol climbs above other matches

    const high = ids(
      await search.invoke(ctx, {
        session_id: s,
        query: "deploy pipeline",
        mode: "text",
        limit: 10,
      }),
    );

    expect(high[high.length - 1]).not.toBe(symbol); // no longer pinned to the bottom
    expect(high.indexOf(symbol)).toBeLessThan(low.indexOf(symbol));
  });

  it("asking for symbols explicitly bypasses the penalty (escape hatch)", async () => {
    const { ctx } = makeCtx();
    const { s, symbol } = await corpus(ctx);

    process.env.MEMORY_SYMBOL_WEIGHT = "0.01"; // would sink the symbol to the bottom...

    const plain = ids(
      await search.invoke(ctx, {
        session_id: s,
        query: "deploy pipeline",
        mode: "text",
        limit: 10,
      }),
    );
    // ...but an explicit symbol request ignores the weight, restoring the raw position.
    const escaped = ids(
      await search.invoke(ctx, {
        session_id: s,
        query: "deploy pipeline",
        types: ["symbol", "fact"],
        mode: "text",
        limit: 10,
      }),
    );

    expect(escaped.indexOf(symbol)).toBeLessThan(plain.indexOf(symbol));
  });
});
