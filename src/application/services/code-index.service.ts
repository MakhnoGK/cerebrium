import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { inject, injectable } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { CodeRootsNotConfiguredError, RepositoryNotConfiguredError } from "@/application/errors";
import { extractFile, FileExtract } from "@/code/extract";
import { readGitProvenance } from "@/code/git";
import {
  buildResolver,
  looksBinary,
  MAX_BYTES,
  resolveCalls,
  resolveImports,
  sha256,
  walk,
  YIELD_EVERY,
  yieldToLoop,
} from "@/code/indexer";
import { parse } from "@/code/parser";
import { CodeRepo, EmbeddingQueueRepo } from "@/db/repositories";
import type { FileIndexResult, IndexStats, IndexTarget } from "@/core/types";
import { EdgeType } from "@/core/vocab";
import { CodeConfig } from "@/infrastructure/config";

export interface IndexRunOptions {
  session_id: string;
  force?: boolean;
}

@injectable()
export class CodeIndexService {
  constructor(
    private readonly code: CodeRepo,
    private readonly queue: EmbeddingQueueRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
    private readonly codeConfig: CodeConfig,
  ) {}

  // An explicit `path` wins; otherwise a name resolves against the roots configured in
  // MEMORY_CODE_ROOTS plus those remembered from a prior index-by-path (env wins on a
  // clash), so a repo indexed once by `path` can later be re-indexed by name.
  public resolveTargets({ repo, path }: { repo?: string; path?: string }): IndexTarget[] {
    if (path) {
      return [{ name: basename(path.replace(/\/+$/, "")) || path, root: path }];
    }

    const byName = new Map<string, IndexTarget>();

    this.code.storedRepoRoots().forEach((root) => {
      byName.set(root.name, root);
    });

    this.codeConfig.roots.forEach((root) => {
      byName.set(root.name, root);
    });

    if (repo) {
      const found = byName.get(repo);

      if (!found) {
        throw new RepositoryNotConfiguredError(repo);
      }

      return [found];
    }

    const known = [...byName.values()];

    if (!known.length) {
      throw new CodeRootsNotConfiguredError();
    }

    return known;
  }

  public async indexTargets(targets: IndexTarget[], opts: IndexRunOptions): Promise<IndexStats[]> {
    return Promise.all(targets.map((target) => this.indexTarget(target, opts)));
  }

  public async indexTarget(target: IndexTarget, opts: IndexRunOptions): Promise<IndexStats> {
    const start = Date.parse(this.clock.now());

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

      if (!opts.force && this.code.codeFileHash(target.name, c.rel) === fileHash) {
        stats.files_skipped++;
        continue; // hash-gate: unchanged file, nothing parsed or re-embedded
      }

      const source = buf.toString("utf8");
      const tree = await parse(c.wasm, source);
      const extract = extractFile(target.name, c.rel, c.lang, source, tree.rootNode);
      tree.delete(); // free WASM heap; extractFile has copied out everything it needs

      const res: FileIndexResult = this.code.applyFileIndex({
        repo: target.name,
        path: c.rel,
        lang: c.lang,
        fileHash,
        symbols: extract.symbols,
        defines: extract.defines,
        session_id: opts.session_id,
        ts: this.clock.now(),
      });

      stats.files_indexed++;
      stats.symbols_added += res.added;
      stats.symbols_updated += res.updated;
      stats.symbols_invalidated += res.invalidated;
      stats.edges_written += res.edges;

      dirty.push({ rel: c.rel, lang: c.lang, extract });

      if (stats.files_indexed % YIELD_EVERY === 0) {
        await yieldToLoop();
      }
    }

    // ---- Sweep: files gone from disk -> invalidate their symbols ----
    for (const path of this.code.listCodeFilePaths(target.name)) {
      if (!onDisk.has(path)) {
        stats.symbols_invalidated += this.code.removeFile(target.name, path, this.clock.now());
      }
    }

    // ---- Pass 2: cross-file imports/calls, resolved against the full directory ----
    if (dirty.length) {
      const resolver = buildResolver(this.code, target.name);
      let resolved = 0;

      for (const { rel, lang, extract } of dirty) {
        const importPairs = resolveImports(resolver, rel, extract);
        const callPairs = resolveCalls(resolver, rel, lang, extract);

        stats.edges_written += this.code.rebuildResolvedEdges(
          target.name,
          rel,
          EdgeType.IMPORTS,
          importPairs,
          opts.session_id,
          this.clock.now(),
        );
        stats.edges_written += this.code.rebuildResolvedEdges(
          target.name,
          rel,
          EdgeType.CALLS,
          callPairs,
          opts.session_id,
          this.clock.now(),
        );

        if (++resolved % YIELD_EVERY === 0) {
          await yieldToLoop();
        }
      }
    }

    const provenance = readGitProvenance(target.root);
    stats.branch = provenance.branch;
    stats.commit = provenance.commit;
    stats.dirty = provenance.dirty;

    this.code.setRepoProvenance(
      target.name,
      target.root,
      provenance.branch,
      provenance.commit,
      provenance.dirty,
      this.clock.now(),
    );

    stats.parked_embeddings = this.queue.embeddingStats().parked;
    stats.duration_ms = Math.max(0, Date.parse(this.clock.now()) - start);

    return stats;
  }
}
