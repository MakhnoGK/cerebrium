import { describe, expect, it } from "vitest";
import { langForPath } from "@/code/languages";
import { parse } from "@/code/parser";

const SOURCES: Record<string, string> = {
  "a.ts": "export function f(x: number) {\n  return x;\n}\n",
  "a.php": "<?php\nfunction f($x) {\n  return $x;\n}\n",
  "a.rs": "pub fn f(x: i32) -> i32 {\n    x\n}\n",
  "a.c": "int f(int x) {\n  return x;\n}\n",
  "a.cpp": "int f(int x) {\n  return x;\n}\n",
  "a.lua": "local M = {}\nfunction M.f(x)\n  return x\nend\nreturn M\n",
};

describe("Grammar stability across repeated parses", () => {
  // A whole-repo index parses many files through one grammar instance. The Lua build
  // in tree-sitter-wasms carries an external scanner whose state survives a parse, so
  // only the first file came out right — the reason src/code/vendor exists.
  it.each(Object.entries(SOURCES))(
    "should parse %s without error on every repeat, not just the first",
    async (path, source) => {
      // Given
      const def = langForPath(path)!;

      // When
      const errored: number[] = [];
      for (let i = 0; i < 4; i++) {
        const tree = await parse(def.wasm, source, def.vendored);
        if (tree.rootNode.hasError) errored.push(i);
        tree.delete();
      }

      // Then
      expect(errored).toEqual([]);
    },
  );

  it("should keep a Lua file's symbols intact when another Lua file was parsed first", async () => {
    // Given
    const def = langForPath("x.lua")!;
    const other = "-- other module\nlocal N = {}\nfunction N.g() end\nreturn N\n";
    const target =
      "local M = {}\n\n--- Hash a token.\nfunction M.hash_token(input)\n  return input\nend\n\nreturn M\n";

    // When
    (await parse(def.wasm, other, def.vendored)).delete();
    const tree = await parse(def.wasm, target, def.vendored);

    // Then
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.namedChildren.map((c) => c?.type)).toEqual([
      "variable_declaration",
      "comment",
      "function_declaration",
      "return_statement",
    ]);
    tree.delete();
  });
});
