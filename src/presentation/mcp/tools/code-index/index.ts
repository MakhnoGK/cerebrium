import { basename } from "node:path";
import { CodeIndexService, EmbeddingService, HintsService } from "@/application/services";
import { CodeRepo } from "@/db/repositories";
import type { IndexStats, IndexTarget } from "@/core/types";
import { metadata } from "@/presentation/mcp/tools/code-index/metadata";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";
import { CodeConfig } from "@/infrastructure/config";

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

@tool()
export class CodeIndexTool implements McpTool<(typeof metadata)["schema"], ToolResponse> {
  public getMetadata = () => metadata;

  constructor(
    private readonly embeddings: EmbeddingService,
    private readonly hints: HintsService,

    private readonly indexer: CodeIndexService,

    // TODO: Move to services
    private readonly code: CodeRepo,

    private readonly codeConfig: CodeConfig,
  ) {}

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<ToolResponse> {
    // TODO: Move to the app layer
    const targets = this.getTargets(args);
    const results = await this.indexer.indexTargets(targets, {
      session_id: args.session_id,
      force: args.force,
    });

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
}
