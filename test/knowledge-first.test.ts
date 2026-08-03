import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { container } from "tsyringe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "@/db/repo";
import { MemoryKind } from "@/core/vocab";
import { CodeIndexTool } from "@/presentation/mcp/tools/code-index";
import { SearchTool } from "@/presentation/mcp/tools/search";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup, TestEnv } from "@test/helpers";

const DEPLOY = `/**
 * deploy pipeline deploy pipeline
 */
export function deployPipeline(): void {}
`;

let root: string;

function idsOf(res: { results: { id: string }[] }): string[] {
  return res.results.map((e) => e.id);
}

// A three-node corpus for "deploy pipeline": a strong fact (title match on both terms),
// a code symbol (body match only), and a weak fact (one term). The symbol weight moves
// the symbol within that fixed frame, isolating the knowledge-first behavior.
async function corpus(
  env: TestEnv,
): Promise<{ s: string; strong: string; symbol: string; weak: string }> {
  const s = (await container.resolve(SessionStartTool).invoke({})).session_id;
  const stats = (await container.resolve(CodeIndexTool).invoke({ session_id: s, path: root })) as {
    repo: string;
  };
  const symbol = env.code.findSymbolsByName("deployPipeline", stats.repo, 1)[0]!.envelope.id;
  const write = container.resolve(WriteTool);
  const strong = (
    (await write.invoke({
      session_id: s,
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title: "Deploy pipeline",
      content: "deploy pipeline release runbook steps",
    })) as Envelope
  ).id;
  const weak = (
    (await write.invoke({
      session_id: s,
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title: "Notebook",
      content: "the deploy step only",
    })) as Envelope
  ).id;

  return { s, strong, symbol, weak };
}

function textSearch(s: string, types?: string[]) {
  return container
    .resolve(SearchTool)
    .invoke({ session_id: s, query: "deploy pipeline", mode: "text", limit: 10, types })
    .then(idsOf);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mk-kf-"));
  mkdirSync(join(root, "svc"), { recursive: true });
  writeFileSync(join(root, "svc", "deploy.ts"), DEPLOY);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.MEMORY_SYMBOL_WEIGHT;
});

describe("Knowledge-first ranking", () => {
  it("should rank authored knowledge above a code symbol by default", async () => {
    // Given
    const env = setup();
    const { s, strong, symbol } = await corpus(env);

    // When
    const def = await textSearch(s);

    // Then
    expect(def).toContain(symbol);
    expect(def.indexOf(strong)).toBeLessThan(def.indexOf(symbol)); // authored above code
  });

  it("should move the symbol monotonically as the configurable symbol weight changes", async () => {
    // Given
    const env = setup();
    const { s, symbol } = await corpus(env);

    // When — a heavy penalty sinks the symbol to the bottom.
    process.env.MEMORY_SYMBOL_WEIGHT = "0.01";
    const low = await textSearch(s);
    expect(low[low.length - 1]).toBe(symbol);

    // When — a heavy boost lifts it above other matches.
    process.env.MEMORY_SYMBOL_WEIGHT = "100";
    const high = await textSearch(s);

    // Then
    expect(high[high.length - 1]).not.toBe(symbol);
    expect(high.indexOf(symbol)).toBeLessThan(low.indexOf(symbol));
  });

  it("should bypass the penalty when symbols are asked for explicitly", async () => {
    // Given
    const env = setup();
    const { s, symbol } = await corpus(env);
    process.env.MEMORY_SYMBOL_WEIGHT = "0.01"; // would sink the symbol...

    // When
    const plain = await textSearch(s);
    const escaped = await textSearch(s, ["symbol", "fact"]);

    // Then — an explicit symbol request ignores the weight, restoring the raw position.
    expect(escaped.indexOf(symbol)).toBeLessThan(plain.indexOf(symbol));
  });
});
