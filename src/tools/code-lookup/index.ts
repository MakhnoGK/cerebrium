import { ToolArgs } from "@/tools/context";
import type { SymbolLookup } from "@/db/repo";
import { McpTool } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { metadata } from "@/tools/code-lookup/metadata";
import { CodeRepo } from "@/db/repositories";
import { HintsService } from "@/tools/services/hints.service";

@tool()
export class CodeLookupTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    private readonly code: CodeRepo,
  ) {}

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const hints = await this.hints.getUnknownSessionHints(args.session_id, null);

    if (!args.name && !args.file) {
      throw new Error("provide `name` (resolve a symbol) or `file` (list a file's symbols).");
    }

    const found = args.name
      ? this.code.findSymbolsByName(args.name, args.repo, args.limit)
      : this.code.findSymbolsInFile(args.repo, args.file!, args.limit);

    const out: Record<string, unknown> = { symbols: found.map(present) };

    if (hints.length) out.hints = hints;

    return out;
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
