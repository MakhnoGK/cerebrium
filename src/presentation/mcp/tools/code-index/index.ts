import { CodeIndexService, EmbeddingService, HintsService } from "@/application/services";
import type { IndexStats } from "@/core/types";
import { metadata } from "@/presentation/mcp/tools/code-index/metadata";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";

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
  ) {}

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<ToolResponse> {
    const targets = this.indexer.resolveTargets(args);
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
}
