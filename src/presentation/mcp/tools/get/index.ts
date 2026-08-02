import { HintsService } from "@/application/services";
import { CodeRepo, MirrorRepo, NodesRepo } from "@/db/repositories";
import { MemoryKind } from "@/core/vocab";
import { McpTool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { metadata } from "@/presentation/mcp/tools/get/metadata";

// `nodes` stays `unknown[]`: its shape varies by node kind (symbol source, mirror facets,
// a pinned revision), and only its length is needed at the audit boundary.
interface GetResponse {
  nodes: unknown[];
  not_found?: string[];
  hints?: string[];
}

@tool()
export class GetTool implements McpTool<(typeof metadata)["schema"], GetResponse> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    // TODO: Move to services
    private readonly nodes: NodesRepo,
    private readonly code: CodeRepo,
    private readonly mirror: MirrorRepo,
  ) {}

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<GetResponse> {
    const hints = await this.hints.getUnknownSessionHints(args.session_id, null);

    if (args.rev !== undefined && args.ids.length !== 1) {
      // TODO: Domain error
      throw new Error("`rev` can only be used when `ids` has exactly one element.");
    }

    const nodes: unknown[] = [];
    const notFound: string[] = [];

    for (const id of args.ids) {
      const full = await this.nodes.fullNode(id);

      if (!full) {
        notFound.push(id);
        continue;
      }

      const node: Record<string, unknown> = {
        ...full.envelope,
        content: full.content,
        edges: full.edges,
      };

      if (full.envelope.type === "symbol") {
        const detail = this.code.symbolDetail(id);

        if (detail) {
          // For a code mirror, `get` is the sanctioned place to return the raw source
          // slice + structured facets (search/code_lookup return envelopes only).
          const { source, ...facets } = detail;
          node.symbol = facets;
          node.source = source;
        }
      } else if (full.envelope.kind === MemoryKind.MIRROR) {
        // For an external mirror, `get` also carries the source back-reference, the
        // deep-link URL, and the opaque facet metadata (search returns envelopes only).
        const rec = this.mirror.mirrorRecord(id);

        if (rec) {
          node.mirror = { source_id: rec.source_id, native_id: rec.native_id };

          if (rec.url != null) {
            node.url = rec.url;
          }

          if (rec.facets != null) {
            node.facets = rec.facets;
          }
        }
      }

      if (args.rev !== undefined) {
        const old = this.nodes.revisionContent(id, args.rev);

        if (old === undefined) {
          throw new Error(`node ${id} has no revision ${args.rev}.`);
        }

        node.content = old;
        node.shown_rev = args.rev;
      }

      if (args.include_revisions) {
        node.revisions = this.nodes.listRevisions(id);
      }

      nodes.push(node);
    }

    const out: GetResponse = { nodes };

    if (notFound.length) out.not_found = notFound;
    if (hints.length) out.hints = hints;

    return out;
  }

  // The fetch half of the retrieval-outcome log: the requested ids join against the ids a
  // preceding `search` returned, `found` says how many still resolved.
  public describeEvent(args: ToolArgs<(typeof metadata)["schema"]>, result: GetResponse) {
    const detail: Record<string, unknown> = {
      ids: args.ids,
      found: result.nodes.length,
    };

    if (result.not_found?.length) {
      detail.not_found = result.not_found;
    }

    return { node_id: args.ids[0] ?? null, detail };
  }
}
