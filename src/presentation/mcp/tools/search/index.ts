import { inject } from "tsyringe";
import {
  SEARCH_MEMORY,
  SESSION_HINTS,
  type SearchMemory,
  type SearchResult,
  type SessionHints,
} from "@/application/use-cases";
import { McpTool, tool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { metadata } from "@/presentation/mcp/tools/search/metadata";

type Schema = (typeof metadata)["schema"];

interface ToolResponse {
  results: SearchResult[];
  total_matches: number;
  hints?: string[];
  context_notes?: string[];
}

@tool()
export class SearchTool implements McpTool<Schema, ToolResponse> {
  public getMetadata = () => metadata;

  constructor(
    @inject(SESSION_HINTS) private readonly sessionHints: SessionHints,
    @inject(SEARCH_MEMORY) private readonly search: SearchMemory,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<ToolResponse> {
    const { hints } = await this.sessionHints.invoke({ session_id: args.session_id });
    const { results, total_matches, notes } = await this.search.invoke({
      session_id: args.session_id,
      query: args.query,
      limit: args.limit,
      project: args.project,
      kinds: args.kinds,
      types: args.types,
      history: args.history,
      mode: args.mode,
      expand_graph: args.expand_graph,
      as_of: args.as_of,
      valid_at: args.valid_at,
    });

    const out: ToolResponse = { results, total_matches };

    if (hints.length) out.hints = hints;
    if (notes.length) out.context_notes = notes;

    return out;
  }
}
