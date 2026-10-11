import type { SymbolDirEntry } from "@cerebrium/contracts/types";
import type { FileExtract } from "@/code/extract";

export interface Resolver {
  byQualified: Map<string, string>;
  byPathName: Map<string, string>;
  moduleByPath: Map<string, string>;
  byName: Map<string, string>; // repo-wide name -> node_id (first-wins); used when path resolution is unavailable
}

function pathNameKey(path: string, name: string): string {
  return `${path}\0${name}`;
}

export function resolverFrom(entries: SymbolDirEntry[]): Resolver {
  const r: Resolver = {
    byQualified: new Map(),
    byPathName: new Map(),
    moduleByPath: new Map(),
    byName: new Map(),
  };
  for (const e of entries) {
    if (!r.byQualified.has(e.qualified)) r.byQualified.set(e.qualified, e.node_id);
    const key = pathNameKey(e.path, e.name);
    if (!r.byPathName.has(key)) r.byPathName.set(key, e.node_id);
    if (e.symbol_kind === "module") r.moduleByPath.set(e.path, e.node_id);
    else if (!r.byName.has(e.name)) r.byName.set(e.name, e.node_id); // modules excluded — they collide on basenames
  }
  return r;
}

export function resolveImports(
  r: Resolver,
  path: string,
  ex: FileExtract,
): { src: string; dst: string }[] {
  const src = r.moduleByPath.get(path);
  if (!src) return [];

  const pairs: { src: string; dst: string }[] = [];

  for (const imp of ex.imports) {
    let dst: string | undefined;

    if (imp.byName) {
      dst = r.byName.get(imp.name); // e.g. PHP `use` — no path to resolve against
    } else {
      for (const cp of imp.candidatePaths) {
        dst = imp.namespace ? r.moduleByPath.get(cp) : r.byPathName.get(pathNameKey(cp, imp.name));
        if (dst) break;
      }
    }

    if (dst) pairs.push({ src, dst });
  }

  return pairs;
}

// PHP and Rust resolve imports by namespace/path prefix, not a relative file path —
// fall back to a repo-wide name match (best-effort; TS/JS keep the stricter
// same-file/imported resolution).
const NAMESPACED_IMPORTS = new Set(["php", "rust"]);

// C/C++ `#include` and Lua `require` pull a whole file's names into scope with no
// binding list, so a callee may live in any of them — search those files by name
// rather than falling back to the whole repo.
const MODULE_SCOPE_IMPORTS = new Set(["c", "cpp", "lua"]);

export function resolveCalls(
  r: Resolver,
  path: string,
  lang: string,
  ex: FileExtract,
): { src: string; dst: string }[] {
  const importByName = new Map<string, string[]>();
  const moduleScopePaths: string[] = [];

  for (const imp of ex.imports) {
    if (!imp.namespace && !imp.byName) {
      importByName.set(imp.name, imp.candidatePaths);
    } else if (imp.namespace && MODULE_SCOPE_IMPORTS.has(lang)) {
      moduleScopePaths.push(...imp.candidatePaths);
    }
  }

  const pairs: { src: string; dst: string }[] = [];

  for (const call of ex.calls) {
    const src = r.byQualified.get(call.srcQualified);
    let dst = r.byPathName.get(pathNameKey(path, call.callee)); // same-file

    if (!src) {
      continue;
    }

    if (!dst) {
      for (const cp of [...(importByName.get(call.callee) ?? []), ...moduleScopePaths]) {
        dst = r.byPathName.get(pathNameKey(cp, call.callee));
        if (dst) break;
      }
    }

    if (!dst && NAMESPACED_IMPORTS.has(lang)) dst = r.byName.get(call.callee);
    if (dst && dst !== src) pairs.push({ src, dst });
  }

  return pairs;
}
