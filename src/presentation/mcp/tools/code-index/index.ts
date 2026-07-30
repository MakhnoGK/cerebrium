import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { EmbeddingService, HintsService } from "@/application/services";
import { extractFile, FileExtract } from "@/code/extract";
import { readGitProvenance } from "@/code/git";
import {
  IndexOptions,
  IndexStats,
  IndexTarget,
  looksBinary,
  resolveCalls,
  resolveImports,
  sha256,
  walk,
  yieldToLoop,
} from "@/code/indexer";
import { parse } from "@/code/parser";
import { CodeRepo, EmbeddingQueueRepo } from "@/db/repositories";
import type { FileIndexResult } from "@/core/types";
import { EdgeType } from "@/core/vocab";
import { metadata } from "@/presentation/mcp/tools/code-index/metadata";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";
import { CodeConfig } from "@/infrastructure/config";

interface Resolver {
  byQualified: Map<string, string>;
  byPathName: Map<string, string>;
  moduleByPath: Map<string, string>;
  byName: Map<string, string>; // repo-wide name -> node_id (first-wins); used when path resolution is unavailable
}

// TODO: Separate file
class RepositoryNotConfiguredError extends Error {
  constructor(repo: string) {
    super(
      `repo '${repo}' is not configured (MEMORY_CODE_ROOTS) and has not been indexed before. ` +
        "Pass an explicit `path` once — it will be remembered for re-index by name.",
    );
  }
}

// TODO: Separate file
class CodeRootsNotConfiguredError extends Error {
  constructor() {
    super(
      "No code roots configured or remembered. Set MEMORY_CODE_ROOTS (name=path,…) or pass `repo`/`path`.",
    );
  }
}

// TODO: Separate file
type ToolResponse =
  | (IndexStats & {
      hints?: string[];
      context_notes?: string[];
    })
  | {
      repos: IndexStats[];
      hints?: string[];
      context_notes?: string[];
    };

const MAX_BYTES = 1_000_000;
const YIELD_EVERY = 8;

@tool()
export class CodeIndexTool implements McpTool<(typeof metadata)["schema"], ToolResponse> {
  public getMetadata = () => metadata;

  constructor(
    private readonly embeddings: EmbeddingService,
    private readonly hints: HintsService,

    // TODO: Move to services
    private readonly code: CodeRepo,
    private readonly embeddingsRepo: EmbeddingQueueRepo,

    private readonly codeConfig: CodeConfig,
  ) {}

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<ToolResponse> {
    // TODO: Move both to "app layer"
    const targets = this.getTargets(args);
    const results = await this.getIndexingResults(targets, args);

    // TODO: Move both to "app layer"
    const notes = this.embeddings.getEmbeddingNotes();
    const hints = await this.hints.getUnknownSessionHints(args.session_id, null);

    const out: ToolResponse = results.length === 1 ? { ...results[0]! } : { repos: results };

    if (hints.length) {
      out.hints = hints;
    }

    if (notes.length) {
      out.context_notes = notes;
    }

    return out;
  }

  public describeEvent(_args: ToolArgs<(typeof metadata)["schema"]>, result: ToolResponse) {
    const indexed = "repos" in result ? result.repos : [result];

    return indexed.map((stats) => ({
      detail: {
        repo: stats.repo,
        indexed: stats.files_indexed,
        added: stats.symbols_added,
        updated: stats.symbols_updated,
        invalidated: stats.symbols_invalidated,
        branch: stats.branch,
        commit: stats.commit,
      },
    }));
  }

  private getTargets(args: ToolArgs<(typeof metadata)["schema"]>): IndexTarget[] {
    if (args.path) {
      return [{ name: basename(args.path.replace(/\/+$/, "")) || args.path, root: args.path }];
    }

    // Known roots = those configured in MEMORY_CODE_ROOTS plus those remembered from a
    // prior index-by-path (env wins on a name clash). So a repo indexed once by `path`
    // can later be re-indexed by `repo` name with no env config.
    const byName = new Map<string, IndexTarget>();

    this.code.storedRepoRoots().forEach((root) => {
      byName.set(root.name, root);
    });

    this.codeConfig.roots.forEach((root) => {
      byName.set(root.name, root);
    });

    if (args.repo) {
      const found = byName.get(args.repo);

      if (!found) {
        throw new RepositoryNotConfiguredError(args.repo);
      }

      return [found];
    }

    const known = [...byName.values()];

    if (!known.length) {
      throw new CodeRootsNotConfiguredError();
    }

    return known;
  }

  private async getIndexingResults(
    targets: IndexTarget[],
    args: ToolArgs<(typeof metadata)["schema"]>,
  ) {
    return Promise.all(
      targets.map(async (target) => {
        // TODO: Decouple
        return await this.getRepositoryIndex(target, {
          session_id: args.session_id,
          // FIXME: Remove this sh*t
          now: () => new Date().toISOString(),
          force: args.force,
        });
      }),
    );
  }

  // TODO: Decouple
  private async getRepositoryIndex(target: IndexTarget, opts: IndexOptions): Promise<IndexStats> {
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
        ts: opts.now(),
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
        stats.symbols_invalidated += this.code.removeFile(target.name, path, opts.now());
      }
    }

    // ---- Pass 2: cross-file imports/calls, resolved against the full directory ----
    if (dirty.length) {
      const resolver = this.getResolver(target.name);
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
          opts.now(),
        );
        stats.edges_written += this.code.rebuildResolvedEdges(
          target.name,
          rel,
          EdgeType.CALLS,
          callPairs,
          opts.session_id,
          opts.now(),
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
      opts.now(),
    );

    stats.parked_embeddings = this.embeddingsRepo.embeddingStats().parked;
    stats.duration_ms = Math.max(0, Date.parse(opts.now()) - start);

    return stats;
  }

  private getResolver(name: string): Resolver {
    const r: Resolver = {
      byQualified: new Map(),
      byPathName: new Map(),
      moduleByPath: new Map(),
      byName: new Map(),
    };

    for (const e of this.code.repoSymbolDirectory(name)) {
      if (!r.byQualified.has(e.qualified)) {
        r.byQualified.set(e.qualified, e.node_id);
      }

      const key = `${e.path}\0${e.name}`;

      if (!r.byPathName.has(key)) {
        r.byPathName.set(key, e.node_id);
      }

      if (e.symbol_kind === "module") {
        r.moduleByPath.set(e.path, e.node_id);
      } else if (!r.byName.has(e.name)) {
        r.byName.set(e.name, e.node_id); // modules excluded — they collide on basenames
      }
    }

    return r;
  }
}
