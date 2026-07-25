import { z } from "zod";
import { basename } from "node:path";
import type { ToolArgs } from "@/tools/context";
import { touchOrCreate } from "@/tools/context";
import { embeddingNotes } from "@/tools/notes";
import { AbstractTool, ToolName } from "@/tools/contracts";
import type { IndexStats, IndexTarget } from "@/code/indexer";
import { indexRepo, parseCodeRoots } from "@/code/indexer";
import { tool } from "@/tools/contracts/tool";

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
type CodeIndexResult =
  | (IndexStats & {
      hints?: string[];
      context_notes?: string[];
    })
  | {
      repos: IndexStats[];
      hints?: string[];
      context_notes?: string[];
    };

@tool()
export class CodeIndexTool extends AbstractTool {
  name = ToolName.CODE_INDEX;

  description =
    "Index the owner's source repositories into `symbol` mirror nodes and code edges (defines/imports/calls). Run this " +
    "AFTER pulling or changing a repo. It is kernel-side and incremental: unchanged files are hash-gated and cost nothing, " +
    "changed files re-parse and re-embed only the symbols that changed, and files/symbols removed from source are soft- " +
    "invalidated (never deleted). Pass `repo` (a configured MEMORY_CODE_ROOTS name) or `path` (a directory), or neither to " +
    "index all configured roots; `force:true` re-parses everything. It does NOT read code back to you — it returns only a " +
    "compact per-repo summary (files scanned/indexed/skipped, symbols added/updated/invalidated, edges, timing). To read " +
    "the code afterwards use `search` (by meaning) or `code_lookup` (by structure), then `get` for a symbol's source.";

  schema = {
    session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
    repo: z
      .string()
      .optional()
      .describe("Name of a configured repo (from MEMORY_CODE_ROOTS). Omit to index all roots."),
    path: z
      .string()
      .optional()
      .describe("Explicit repo-root directory to index instead of a configured name."),
    force: z
      .boolean()
      .optional()
      .describe("Re-parse every file, bypassing the per-file hash-gate (default false)."),
  };

  async invoke(args: ToolArgs<typeof this.schema>): Promise<CodeIndexResult> {
    // TODO: Move both to "app layer"
    const targets = this.getTargets(args);
    const results = await this.getIndexingResults(targets, args);

    // TODO: Move both to "app layer"
    const notes = embeddingNotes(this.ctx.repo);
    const hints = touchOrCreate(this.ctx, args.session_id);

    const out: CodeIndexResult = results.length === 1 ? { ...results[0]! } : { repos: results };

    if (hints.length) out.hints = hints;
    if (notes.length) out.context_notes = notes;

    return out;
  }

  private getTargets(args: ToolArgs<typeof this.schema>): IndexTarget[] {
    if (args.path) {
      return [{ name: basename(args.path.replace(/\/+$/, "")) || args.path, root: args.path }];
    }

    // Known roots = those configured in MEMORY_CODE_ROOTS plus those remembered from a
    // prior index-by-path (env wins on a name clash). So a repo indexed once by `path`
    // can later be re-indexed by `repo` name with no env config.
    const byName = new Map<string, IndexTarget>();

    this.ctx.repo.storedRepoRoots().forEach((root) => byName.set(root.name, root));
    parseCodeRoots(process.env.MEMORY_CODE_ROOTS).forEach((root) => byName.set(root.name, root));

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

  private async getIndexingResults(targets: IndexTarget[], args: ToolArgs<typeof this.schema>) {
    return Promise.all(
      targets.map(async (target) => {
        const stats = await indexRepo(this.ctx.repo, target, {
          session_id: args.session_id,
          now: this.ctx.now.bind(this.ctx),
          force: args.force,
        });

        this.ctx.repo.logEvent(
          "code_index",
          args.session_id,
          null,
          {
            repo: stats.repo,
            indexed: stats.files_indexed,
            added: stats.symbols_added,
            updated: stats.symbols_updated,
            invalidated: stats.symbols_invalidated,
            branch: stats.branch,
            commit: stats.commit,
          },
          this.ctx.now(),
        );

        return stats;
      }),
    );
  }
}
