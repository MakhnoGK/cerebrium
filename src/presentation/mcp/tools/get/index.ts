import { inject } from "tsyringe";
import {
  FETCH_NODES,
  SESSION_HINTS,
  type FetchNodes,
  type SessionHints,
} from "@/application/use-cases";
import { McpTool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { metadata } from "@/presentation/mcp/tools/get/metadata";

type Schema = (typeof metadata)["schema"];

interface GetResponse {
  nodes: unknown[];
  not_found?: string[];
  hints?: string[];
}

@tool()
export class GetTool implements McpTool<Schema, GetResponse> {
  public getMetadata = () => metadata;

  constructor(
    @inject(SESSION_HINTS) private readonly sessionHints: SessionHints,
    @inject(FETCH_NODES) private readonly fetch: FetchNodes,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<GetResponse> {
    const { hints } = await this.sessionHints.invoke({ session_id: args.session_id });
    const { nodes, not_found } = await this.fetch.invoke({
      session_id: args.session_id,
      ids: args.ids,
      rev: args.rev,
      as_of: args.as_of,
      sections: args.sections,
      outline: args.outline,
      include_revisions: args.include_revisions,
    });

    const out: GetResponse = { nodes };

    if (not_found.length) out.not_found = not_found;
    if (hints.length) out.hints = hints;

    return out;
  }

  // The fetch half of the retrieval-outcome log: the requested ids join against the ids a
  // preceding `search` returned, `found` says how many still resolved. A narrowed fetch also
  // records which sections were read — a finer label than the node id, and the granularity a
  // chunk-level relevance signal needs.
}
