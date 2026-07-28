import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FileExtract } from "@/code/extract";
import { extractFile } from "@/code/extract";
import { readGitProvenance } from "@/code/git";
import { compileIgnore } from "@/code/ignore";
import { langForPath } from "@/code/languages";
import { parse } from "@/code/parser";
import type { FileIndexResult } from "@/db/repo";
import type { CodeRepo, EmbeddingQueueRepo } from "@/db/repositories";
import { EdgeType } from "@/core/vocab";

export interface IndexStats {
  repo: string;
  files_scanned: number;
  files_indexed: number;
  files_skipped: number;
  symbols_added: number;
  symbols_updated: number;
  symbols_invalidated: number;
  edges_written: number;
  duration_ms: number;
  parked_embeddings: number;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
}

export interface IndexTarget {
  name: string;
  root: string;
}

export interface IndexOptions {
  session_id: string;
  now: () => string;
  force?: boolean;
}

// Directories never worth walking, independent of .gitignore.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
  ".turbo",
  ".cache",
  ".vscode-test",
]);
const MAX_BYTES = 1_000_000;
// Yield the event loop this often during a long index so a big repo can't
// monopolize the shared DB — other server processes' writes (and this process's
// own embedding worker) get scheduling gaps between per-file transactions.
const YIELD_EVERY = 8;

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// Real binaries are saturated with NUL bytes; a source occasionally carries one inside
// a string literal (e.g. a "\0" separator). Flag only a high NUL fraction, not the
// first NUL, so a legal source is never dropped.
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);

  if (n === 0) {
    return false;
  }

  let nulls = 0;

  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) nulls++;
  }

  return nulls / n > 0.1;
}

interface Candidate {
  rel: string;
  abs: string;
  lang: string;
  wasm: string;
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
        if (localMatchers.some((m) => m(childRel, false))) continue;
        out.push({ rel: childRel, abs: join(dir, entry.name), lang: def.lang, wasm: def.wasm });
      }
    }
  };

  recur(root, "", ignorers);
  return out;
}

export async function indexRepo(
  code: CodeRepo,
  queue: EmbeddingQueueRepo,
  target: IndexTarget,
  opts: IndexOptions,
): Promise<IndexStats> {
  const start = Date.parse(opts.now());
  const stats: IndexStats = {
    repo: target.name,
    files_scanned: 0,
    files_indexed: 0,
    files_skipped: 0,
    symbols_added: 0,
    symbols_updated: 0,
    symbols_invalidated: 0,
    edges_written: 0,
    duration_ms: 0,
    parked_embeddings: 0,
    branch: null,
    commit: null,
    dirty: false,
  };

  const candidates = existsSync(target.root) ? walk(target.root) : [];
  const onDisk = new Set(candidates.map((c) => c.rel));
  const dirty: { rel: string; lang: string; extract: FileExtract }[] = [];

  // ---- Pass 1: symbols + defines + per-file hash (transactional per file) ----
  for (const c of candidates) {
    stats.files_scanned++;
    let buf: Buffer;
    try {
      if (statSync(c.abs).size > MAX_BYTES) {
        stats.files_skipped++;
        continue;
      }
      buf = readFileSync(c.abs);
    } catch {
      stats.files_skipped++;
      continue;
    }
    if (looksBinary(buf)) {
      stats.files_skipped++;
      continue;
    }
    const fileHash = sha256(buf);
    if (!opts.force && code.codeFileHash(target.name, c.rel) === fileHash) {
      stats.files_skipped++;
      continue; // hash-gate: unchanged file, nothing parsed or re-embedded
    }

    const source = buf.toString("utf8");
    const tree = await parse(c.wasm, source);
    const extract = extractFile(target.name, c.rel, c.lang, source, tree.rootNode);
    tree.delete(); // free WASM heap; extractFile has copied out everything it needs
    const res: FileIndexResult = code.applyFileIndex({
      repo: target.name,
      path: c.rel,
      lang: c.lang,
      fileHash,
      symbols: extract.symbols,
      defines: extract.defines,
      session_id: opts.session_id,
      ts: opts.now(),
    });
    stats.files_indexed++;
    stats.symbols_added += res.added;
    stats.symbols_updated += res.updated;
    stats.symbols_invalidated += res.invalidated;
    stats.edges_written += res.edges;
    dirty.push({ rel: c.rel, lang: c.lang, extract });
    if (stats.files_indexed % YIELD_EVERY === 0) await yieldToLoop();
  }

  // ---- Sweep: files gone from disk -> invalidate their symbols ----
  for (const path of code.listCodeFilePaths(target.name)) {
    if (!onDisk.has(path))
      stats.symbols_invalidated += code.removeFile(target.name, path, opts.now());
  }

  // ---- Pass 2: cross-file imports/calls, resolved against the full directory ----
  if (dirty.length) {
    const resolver = buildResolver(code, target.name);
    let resolved = 0;
    for (const { rel, lang, extract } of dirty) {
      const importPairs = resolveImports(resolver, rel, extract);
      const callPairs = resolveCalls(resolver, rel, lang, extract);
      stats.edges_written += code.rebuildResolvedEdges(
        target.name,
        rel,
        EdgeType.IMPORTS,
        importPairs,
        opts.session_id,
        opts.now(),
      );
      stats.edges_written += code.rebuildResolvedEdges(
        target.name,
        rel,
        EdgeType.CALLS,
        callPairs,
        opts.session_id,
        opts.now(),
      );
      if (++resolved % YIELD_EVERY === 0) await yieldToLoop();
    }
  }

  const prov = readGitProvenance(target.root);
  stats.branch = prov.branch;
  stats.commit = prov.commit;
  stats.dirty = prov.dirty;
  code.setRepoProvenance(
    target.name,
    target.root,
    prov.branch,
    prov.commit,
    prov.dirty,
    opts.now(),
  );

  stats.parked_embeddings = queue.embeddingStats().parked;
  stats.duration_ms = Math.max(0, Date.parse(opts.now()) - start);
  return stats;
}

// ---- cross-file edge resolution --------------------------------------------

interface Resolver {
  byQualified: Map<string, string>;
  byPathName: Map<string, string>;
  moduleByPath: Map<string, string>;
  byName: Map<string, string>; // repo-wide name -> node_id (first-wins); used when path resolution is unavailable
}

function pathNameKey(path: string, name: string): string {
  return `${path}\0${name}`;
}

export function buildResolver(code: CodeRepo, name: string): Resolver {
  const r: Resolver = {
    byQualified: new Map(),
    byPathName: new Map(),
    moduleByPath: new Map(),
    byName: new Map(),
  };
  for (const e of code.repoSymbolDirectory(name)) {
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

export function resolveCalls(
  r: Resolver,
  path: string,
  lang: string,
  ex: FileExtract,
): { src: string; dst: string }[] {
  const importByName = new Map<string, string[]>();

  for (const imp of ex.imports) {
    if (!imp.namespace && !imp.byName) {
      importByName.set(imp.name, imp.candidatePaths);
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
      for (const cp of importByName.get(call.callee) ?? []) {
        dst = r.byPathName.get(pathNameKey(cp, call.callee));
        if (dst) break;
      }
    }

    if (!dst && NAMESPACED_IMPORTS.has(lang)) dst = r.byName.get(call.callee);
    if (dst && dst !== src) pairs.push({ src, dst });
  }

  return pairs;
}

// ---- config ----------------------------------------------------------------

// MEMORY_CODE_ROOTS = "name=path,name2=path2"
export function parseCodeRoots(env: string | undefined): IndexTarget[] {
  if (!env) return [];

  return env.split(",").reduce<IndexTarget[]>((acc, part) => {
    const eq = part.indexOf("=");
    if (eq < 0) return acc;

    const name = part.slice(0, eq).trim();
    const root = part.slice(eq + 1).trim();

    return name && root ? [...acc, { name, root }] : acc;
  }, []);
}
