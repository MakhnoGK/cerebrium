import { ToolArgs, touchOrCreate } from "@/tools/context";
import type { SymbolLookup } from "@/db/repo";
import { McpTool } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { metadata } from "@/tools/code-lookup/metadata";

@tool()
export class CodeLookupTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const hints = touchOrCreate(this.ctx, args.session_id);

    if (!args.name && !args.file) {
      throw new Error("provide `name` (resolve a symbol) or `file` (list a file's symbols).");
    }

    const found = args.name
      ? this.ctx.repo.findSymbolsByName(args.name, args.repo, args.limit)
      : this.ctx.repo.findSymbolsInFile(args.repo, args.file!, args.limit);

    this.ctx.repo.logEvent(
      "code_lookup",
      args.session_id,
      null,
      { name: args.name ?? null, file: args.file ?? null, hits: found.length },
      this.ctx.now(),
    );

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
