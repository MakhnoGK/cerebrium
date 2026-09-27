import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";
import type { Tree } from "web-tree-sitter";

// tree-sitter runs in-process via WASM (no native build, no daemon), matching the
// embedding worker's "in the one-server process" model. Parser.init() loads the
// runtime once; grammars are loaded lazily per language and cached for the process.
const require = createRequire(import.meta.url);
// `vendor/` sits beside this file in src/ and beside the bundle in dist/, the same
// arrangement openDatabase uses for migrations.
const here = dirname(fileURLToPath(import.meta.url));

let initPromise: Promise<void> | null = null;
const grammars = new Map<string, Language>();

async function getGrammar(wasm: string, vendored: boolean): Promise<Language> {
  let lang = grammars.get(wasm);

  if (!lang) {
    const wasmPath = vendored
      ? join(here, "vendor", wasm)
      : require.resolve(`tree-sitter-wasms/out/${wasm}`);
    lang = await Language.load(wasmPath);
    grammars.set(wasm, lang);
  }

  return lang;
}

export async function parse(wasm: string, source: string, vendored = false): Promise<Tree> {
  await (initPromise ??= Parser.init());

  const grammar = await getGrammar(wasm, vendored);
  const parser = new Parser();
  parser.setLanguage(grammar);

  const tree = parser.parse(source);

  if (!tree) {
    throw new Error(`tree-sitter returned no tree for a ${wasm} source`);
  }

  return tree;
}
