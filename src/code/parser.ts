import { Parser, Language } from "web-tree-sitter";
import type { Tree } from "web-tree-sitter";
import { createRequire } from "node:module";

// tree-sitter runs in-process via WASM (no native build, no daemon), matching the
// embedding worker's "in the one-server process" model. Parser.init() loads the
// runtime once; grammars are loaded lazily per language and cached for the process.
const require = createRequire(import.meta.url);

let initPromise: Promise<void> | null = null;
const grammars = new Map<string, Language>();

async function getGrammar(wasm: string): Promise<Language> {
  let lang = grammars.get(wasm);

  if (!lang) {
    const wasmPath = require.resolve(`tree-sitter-wasms/out/${wasm}`);
    lang = await Language.load(wasmPath);
    grammars.set(wasm, lang);
  }

  return lang;
}

export async function parse(wasm: string, source: string): Promise<Tree> {
  await (initPromise ??= Parser.init());

  const grammar = await getGrammar(wasm);
  const parser = new Parser();
  parser.setLanguage(grammar);

  const tree = parser.parse(source);

  if (!tree) {
    throw new Error(`tree-sitter returned no tree for a ${wasm} source`);
  }

  return tree;
}
