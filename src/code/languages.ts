// Language registry: file extension -> logical language name + the tree-sitter
// grammar WASM to load. A small data map by design — adding Python/Go later is a
// new row here plus a matching branch in the extractor, not a rewrite. Files whose
// extension is absent have no grammar and are skipped (and counted) by the indexer.

export interface LangDef {
  lang: string; // logical name stored in the DB (`symbols.lang`, `code_files.lang`)
  wasm: string; // file name under tree-sitter-wasms/out/
}

const BY_EXT: Record<string, LangDef> = {
  ".ts": { lang: "typescript", wasm: "tree-sitter-typescript.wasm" },
  ".mts": { lang: "typescript", wasm: "tree-sitter-typescript.wasm" },
  ".cts": { lang: "typescript", wasm: "tree-sitter-typescript.wasm" },
  ".tsx": { lang: "tsx", wasm: "tree-sitter-tsx.wasm" },
  ".js": { lang: "javascript", wasm: "tree-sitter-javascript.wasm" },
  ".mjs": { lang: "javascript", wasm: "tree-sitter-javascript.wasm" },
  ".cjs": { lang: "javascript", wasm: "tree-sitter-javascript.wasm" },
  ".jsx": { lang: "javascript", wasm: "tree-sitter-javascript.wasm" },
  ".php": { lang: "php", wasm: "tree-sitter-php.wasm" },
  ".rs": { lang: "rust", wasm: "tree-sitter-rust.wasm" },
};

export function langForPath(path: string): LangDef | undefined {
  const dot = path.lastIndexOf(".");

  if (dot < 0) {
    return undefined;
  }

  return BY_EXT[path.slice(dot).toLowerCase()];
}
