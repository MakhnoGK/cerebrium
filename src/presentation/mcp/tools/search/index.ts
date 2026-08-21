import { inject } from "tsyringe";
import {
  SEARCH_MEMORY,
  SESSION_HINTS,
  type SearchAudit,
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

// Telemetry for the `events` row, carried out of `invoke` on a symbol key: symbols are
// invisible to JSON.stringify, so this never reaches the agent or costs it tokens.
const AUDIT = Symbol("search.audit");

type AuditedResponse = ToolResponse & { [AUDIT]?: SearchAudit };

@tool()
export class SearchTool implements McpTool<Schema, AuditedResponse> {
  public getMetadata = () => metadata;

  constructor(
    @inject(SESSION_HINTS) private readonly sessionHints: SessionHints,
    @inject(SEARCH_MEMORY) private readonly search: SearchMemory,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<AuditedResponse> {
    const { hints } = await this.sessionHints.invoke({ session_id: args.session_id });
    const { results, total_matches, notes, audit } = await this.search.invoke({
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

    const out: AuditedResponse = { results, total_matches };

    if (hints.length) out.hints = hints;
    if (notes.length) out.context_notes = notes;

    out[AUDIT] = audit;

    return out;
  }

  public describeEvent(_args: ToolArgs<Schema>, result: AuditedResponse) {
    return { detail: result[AUDIT] ?? null };
  }
}
