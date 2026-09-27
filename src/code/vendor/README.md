# Vendored tree-sitter grammars

Grammars that `tree-sitter-wasms` (the source of every other grammar in
`src/code/languages.ts`) cannot supply in working order.

## `tree-sitter-lua.wasm`

- **Source:** [`tree-sitter-wasm@2.0.1`](https://www.npmjs.com/package/tree-sitter-wasm)
  (`out/lua/tree-sitter-lua.wasm`), MIT, built from
  [`tree-sitter-grammars/tree-sitter-lua`](https://github.com/tree-sitter-grammars/tree-sitter-lua).
- **sha256:** `aedb69dbe1d27c031dde44e40e4ebb3c709adc51097be9f4114c60d6bd0262a4`
- **Why not `tree-sitter-wasms`:** its Lua build (every published version, 0.1.9
  through 0.1.13) carries an external scanner whose state survives a parse, so only
  the *first* Lua file parsed in a process comes out correct and every later one
  gains spurious `ERROR` nodes and loses symbols. `parser.delete()`, `parser.reset()`
  and reloading the `Language` all fail to clear it. No other grammar in that package
  is affected. Depending on `tree-sitter-wasm` instead would pull 115 MB for this one
  file.

To update: take the file from a newer `tree-sitter-wasm` release, refresh the hash
above, and re-run `npm test` — `test/code-extract.test.ts` covers the node types the
extractor depends on.
