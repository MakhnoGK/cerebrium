import { inject } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { HintsService } from "@/application/services";
import { ChunksRepo, CodeRepo, MirrorRepo, NodesRepo } from "@/db/repositories";
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
    private readonly chunks: ChunksRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<GetResponse> {
    const hints = await this.hints.getSessionHints(args.session_id);

    if (args.rev !== undefined && args.ids.length !== 1) {
      // TODO: Domain error
      throw new Error("`rev` can only be used when `ids` has exactly one element.");
    }

    if (args.rev !== undefined && args.as_of !== undefined) {
      throw new Error(
        "`rev` and `as_of` both pick a revision; pass one. `as_of` resolves the revision current at that time.",
      );
    }

    if (args.sections !== undefined && args.ids.length !== 1) {
      throw new Error(
        "`sections` names one node's headings, so it can only be used when `ids` has exactly one element. " +
          "Pass `outline:true` instead to see every id's sections.",
      );
    }

    const narrowing = args.sections !== undefined || args.outline === true;

    // Sections address live chunks, which only exist for the current revision — a
    // superseded body was never chunked under its own headings.
    if (narrowing && (args.rev !== undefined || args.as_of !== undefined)) {
      throw new Error(
        "sections address the current revision's chunks, which a past revision does not have; " +
          "drop `sections`/`outline`, or drop `rev`/`as_of` and narrow the current body.",
      );
    }

    const nodes: unknown[] = [];
    const notFound: string[] = [];
    const used: string[] = [];

    for (const id of args.ids) {
      const full = await this.nodes.fullNode(id);

      if (!full) {
        notFound.push(id);
        continue;
      }

      // Under as_of the node has to have existed and still been valid then; a node that was
      // not yet written, or already invalidated, is simply absent from that view.
      const past = args.as_of === undefined ? undefined : this.nodes.stateAt(id, args.as_of);

      if (args.as_of !== undefined && !past) {
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

      const window = this.nodes.eventWindow(id);

      if (window?.event_from != null) node.event_from = window.event_from;
      if (window?.event_to != null) node.event_to = window.event_to;

      if (past) {
        node.content = past.content;
        node.shown_rev = past.rev;
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

      if (narrowing) {
        const outline = this.chunks.sections(id);

        node.outline = outline;
        // Whatever is asked for, it is a slice of the body; the raw source of a code
        // mirror is not addressable by heading and would defeat the narrowing.
        delete node.source;

        if (args.sections === undefined) {
          delete node.content;
        } else {
          const picked = this.chunks.sectionText(id, args.sections);

          if (picked.missing.length) {
            const available = outline.map((s) => s.section);

            throw new Error(
              `node ${id} has no section named ${picked.missing.map((s) => `"${s}"`).join(", ")}. ` +
                (available.length
                  ? `It has: ${available.map((s) => `"${s}"`).join(", ")}.`
                  : "It has no headings to address; fetch it without `sections`."),
            );
          }

          node.content = picked.text;
        }
      }

      nodes.push(node);
      used.push(id);
    }

    this.nodes.recordUse(used, this.clock.now());

    const out: GetResponse = { nodes };

    if (notFound.length) out.not_found = notFound;
    if (hints.length) out.hints = hints;

    return out;
  }

  // The fetch half of the retrieval-outcome log: the requested ids join against the ids a
  // preceding `search` returned, `found` says how many still resolved. A narrowed fetch also
  // records which sections were read — a finer label than the node id, and the granularity a
  // chunk-level relevance signal needs.
  public describeEvent(args: ToolArgs<(typeof metadata)["schema"]>, result: GetResponse) {
    const detail: Record<string, unknown> = {
      ids: args.ids,
      found: result.nodes.length,
    };

    if (result.not_found?.length) {
      detail.not_found = result.not_found;
    }

    if (args.sections?.length) {
      detail.sections = args.sections;
    }

    // An outline is a decision aid, not a read; keeping it distinguishable stops it
    // being counted as evidence the agent found the node worth its tokens.
    if (args.outline === true) {
      detail.outline = true;
    }

    return { node_id: args.ids[0] ?? null, detail };
  }
}
