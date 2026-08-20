import { inject } from "tsyringe";
import {
  LOOKUP_CODE,
  SESSION_HINTS,
  type LookupCode,
  type SessionHints,
} from "@/application/use-cases";
import type { SymbolLookup } from "@/core/types";
import { metadata } from "@/presentation/mcp/tools/code-lookup/metadata";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";

type Schema = (typeof metadata)["schema"];

interface ToolResponse {
  symbols: Record<string, unknown>[];
  hints?: string[];
}

@tool()
export class CodeLookupTool implements McpTool<Schema, ToolResponse> {
  public getMetadata = () => metadata;

  constructor(
    @inject(SESSION_HINTS) private readonly sessionHints: SessionHints,
    @inject(LOOKUP_CODE) private readonly lookup: LookupCode,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<ToolResponse> {
    const { hints } = await this.sessionHints.invoke({ session_id: args.session_id });
    const { symbols } = await this.lookup.invoke({
      name: args.name,
      file: args.file,
      repo: args.repo,
      limit: args.limit,
    });

    const out: ToolResponse = { symbols: symbols.map(present) };

    if (hints.length) out.hints = hints;

    return out;
  }

  // Same retrieval-outcome log as `search`: the lookup key stands in for the query.
  public describeEvent(args: ToolArgs<Schema>, result: ToolResponse) {
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
