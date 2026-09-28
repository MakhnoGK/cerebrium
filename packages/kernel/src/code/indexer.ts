import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { langForPath, SKIP_DIRS, SKIP_FILES } from "@cerebrium/contracts/code";
import type { SymbolDirEntry } from "@cerebrium/contracts/types";
import { type CodeRepo } from "@/domain/ports/storage";
import type { FileExtract } from "@/code/extract";
import { compileIgnore } from "@/code/ignore";

export { looksBinary, MAX_BYTES } from "@cerebrium/contracts/code";

// Yield the event loop this often during a long index so a big repo can't
// monopolize the shared DB — other server processes' writes (and this process's
// own embedding worker) get scheduling gaps between per-file transactions.
export const YIELD_EVERY = 8;

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface Candidate {
  rel: string;
  abs: string;
  lang: string;
  wasm: string;
  vendored: boolean;
}

// Walk `root`, yielding indexable files (known grammar, not ignored/binary/oversized).
// A directory's own .gitignore extends the inherited rules for its subtree.
export function walk(root: string): Candidate[] {
  const out: Candidate[] = [];
  const rootIgnore = existsSync(join(root, ".gitignore"))
    ? compileIgnore(readFileSync(join(root, ".gitignore"), "utf8"))
    : null;
  const ignorers = rootIgnore ? [rootIgnore] : [];

  const recur = (
    dir: string,
    rel: string,
    matchers: ((p: string, d: boolean) => boolean)[],
  ): void => {
    let localMatchers = matchers;
    const gi = join(dir, ".gitignore");
    if (rel && existsSync(gi))
      localMatchers = [...matchers, compileIgnore(readFileSync(gi, "utf8"))];

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (localMatchers.some((m) => m(childRel, true))) continue;
        recur(join(dir, entry.name), childRel, localMatchers);
      } else if (entry.isFile()) {
        const def = langForPath(entry.name);
        if (!def) continue; // no grammar -> not a code file
        if (SKIP_FILES.some((re) => re.test(entry.name))) continue;
        if (localMatchers.some((m) => m(childRel, false))) continue;
        out.push({
          rel: childRel,
          abs: join(dir, entry.name),
          lang: def.lang,
          wasm: def.wasm,
          vendored: def.vendored ?? false,
        });
      }
    }
  };

  recur(root, "", ignorers);
  return out;
}

// ---- cross-file edge resolution --------------------------------------------

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

export async function buildResolver(code: CodeRepo, name: string): Promise<Resolver> {
  return resolverFrom(await code.repoSymbolDirectory(name));
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
