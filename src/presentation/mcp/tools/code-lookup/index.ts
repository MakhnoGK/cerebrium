import { HintsService } from "@/application/services";
import type { SymbolLookup } from "@/db/repo";
import { CodeRepo } from "@/db/repositories";
import { metadata } from "@/presentation/mcp/tools/code-lookup/metadata";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";

interface ToolResponse {
  symbols: Record<string, unknown>[];
  hints?: string[];
}

@tool()
export class CodeLookupTool implements McpTool<(typeof metadata)["schema"], ToolResponse> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    private readonly code: CodeRepo,
  ) {}

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<ToolResponse> {
    const hints = await this.hints.getSessionHints(args.session_id);

    if (!args.name && !args.file) {
      throw new Error("provide `name` (resolve a symbol) or `file` (list a file's symbols).");
    }

    const found = args.name
      ? this.code.findSymbolsByName(args.name, args.repo, args.limit)
      : this.code.findSymbolsInFile(args.repo, args.file!, args.limit);

    const out: ToolResponse = { symbols: found.map(present) };

    if (hints.length) out.hints = hints;

    return out;
  }

  // Same retrieval-outcome log as `search`: the lookup key stands in for the query.
  public describeEvent(args: ToolArgs<(typeof metadata)["schema"]>, result: ToolResponse) {
    const detail: Record<string, unknown> = {
      results: result.symbols.length,
      ids: result.symbols.map((s) => s.id).filter((id): id is string => typeof id === "string"),
    };

    if (args.name) detail.name = args.name;
    if (args.file) detail.file = args.file;
    if (args.repo) detail.repo = args.repo;

    return { detail };
  }
}

function present(s: SymbolLookup): Record<string, unknown> {
  return {
    ...s.envelope,
    symbol_kind: s.facets.symbol_kind,
    signature: s.facets.signature,
    repo: s.facets.repo,
    path: s.facets.path,
    start_line: s.facets.start_line,
    end_line: s.facets.end_line,
    neighbors: s.neighbors,
  };
}
