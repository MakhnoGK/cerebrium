import { ToolArgs, touchOrCreate } from "@/tools/context";
import { McpTool } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { metadata } from "@/tools/get/metadata";

@tool()
export class GetTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const hints = touchOrCreate(this.ctx, args.session_id);

    if (args.rev !== undefined && args.ids.length !== 1) {
      throw new Error("`rev` can only be used when `ids` has exactly one element.");
    }

    const nodes: unknown[] = [];
    const notFound: string[] = [];

    for (const id of args.ids) {
      const full = this.ctx.repo.fullNode(id);

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
        const detail = this.ctx.repo.symbolDetail(id);

        if (detail) {
          // For a code mirror, `get` is the sanctioned place to return the raw source
          // slice + structured facets (search/code_lookup return envelopes only).
          const { source, ...facets } = detail;
          node.symbol = facets;
          node.source = source;
        }
      } else if (full.envelope.kind === "mirror") {
        // For an external mirror, `get` also carries the source back-reference, the
        // deep-link URL, and the opaque facet metadata (search returns envelopes only).
        const rec = this.ctx.repo.mirrorRecord(id);

        if (rec) {
          node.mirror = { source_id: rec.source_id, native_id: rec.native_id };
          if (rec.url != null) node.url = rec.url;
          if (rec.facets != null) node.facets = rec.facets;
        }
      }

      if (args.rev !== undefined) {
        const old = this.ctx.repo.revisionContent(id, args.rev);
        if (old === undefined) throw new Error(`node ${id} has no revision ${args.rev}.`);
        node.content = old;
        node.shown_rev = args.rev;
      }
      if (args.include_revisions) node.revisions = this.ctx.repo.listRevisions(id);
      nodes.push(node);
    }

    this.ctx.repo.logEvent(
      "get",
      args.session_id,
      args.ids[0] ?? null,
      { count: args.ids.length },
      this.ctx.now(),
    );

    const out: Record<string, unknown> = { nodes };

    if (notFound.length) out.not_found = notFound;
    if (hints.length) out.hints = hints;

    return out;
  }
}
