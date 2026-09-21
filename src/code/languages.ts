// Language registry: file extension -> logical language name + the tree-sitter
// grammar WASM to load. A small data map by design — adding Python/Go later is a
// new row here plus a matching branch in the extractor, not a rewrite. Files whose
// extension is absent have no grammar and are skipped (and counted) by the indexer.

export interface LangDef {
  lang: string; // logical name stored in the DB (`symbols.lang`, `code_files.lang`)
  wasm: string; // grammar file name
  vendored?: boolean; // resolve from src/code/vendor instead of tree-sitter-wasms/out
}

const CPP = "tree-sitter-cpp.wasm";

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
  ".c": { lang: "c", wasm: "tree-sitter-c.wasm" },
  // `.h` is ambiguous C/C++/Objective-C; the C++ grammar accepts nearly all C, while
  // the C grammar turns every `class` in a C++ header into an ERROR node.
  ".h": { lang: "c", wasm: CPP },
  ".cpp": { lang: "cpp", wasm: CPP },
  ".cc": { lang: "cpp", wasm: CPP },
  ".cxx": { lang: "cpp", wasm: CPP },
  ".hpp": { lang: "cpp", wasm: CPP },
  ".hh": { lang: "cpp", wasm: CPP },
  ".hxx": { lang: "cpp", wasm: CPP },
  ".ipp": { lang: "cpp", wasm: CPP },
  ".tpp": { lang: "cpp", wasm: CPP },
  ".inl": { lang: "cpp", wasm: CPP },
  // tree-sitter-wasms' Lua build mis-parses every file after the first one in a
  // process; src/code/vendor/README.md has the detail.
  ".lua": { lang: "lua", wasm: "tree-sitter-lua.wasm", vendored: true },
};

export function langForPath(path: string): LangDef | undefined {
  const dot = path.lastIndexOf(".");

  if (dot < 0) {
    return undefined;
  }

  return BY_EXT[path.slice(dot).toLowerCase()];
}
