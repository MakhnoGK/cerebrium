import { inject } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { USE_RECORDER_TOKEN, type UseRecorder } from "@/domain/ports/use-recorder";
import {
  FETCH_NODES,
  useCase,
  type FetchNodes,
  type FetchNodesArgs,
  type FetchNodesResult,
} from "@/application/use-cases/contracts";
import { ChunksRepo, CodeRepo, MirrorRepo, NodesRepo } from "@/db/repositories";
import { MemoryKind } from "@/core/vocab";

@useCase(FETCH_NODES)
export class LocalFetchNodes implements FetchNodes {
  constructor(
    private readonly nodes: NodesRepo,
    private readonly code: CodeRepo,
    private readonly mirror: MirrorRepo,
    private readonly chunks: ChunksRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
    @inject(USE_RECORDER_TOKEN) private readonly uses: UseRecorder,
  ) {}

  async invoke(args: FetchNodesArgs): Promise<FetchNodesResult> {
    this.reject(args);

    const narrowing = args.sections !== undefined || args.outline === true;
    const nodes: unknown[] = [];
    const not_found: string[] = [];
    const used: string[] = [];

    for (const id of args.ids) {
      const full = await this.nodes.fullNode(id);

      if (!full) {
        not_found.push(id);
        continue;
      }

      // Under as_of the node has to have existed and still been valid then; a node that was
      // not yet written, or already invalidated, is simply absent from that view.
      const past = args.as_of === undefined ? undefined : this.nodes.stateAt(id, args.as_of);

      if (args.as_of !== undefined && !past) {
        not_found.push(id);
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
        this.narrow(node, id, args.sections);
      }

      nodes.push(node);
      used.push(id);
    }

    this.uses.recordUse(used, this.clock.now());

    return { nodes, not_found, used };
  }

  private reject(args: FetchNodesArgs): void {
    if (args.rev !== undefined && args.ids.length !== 1) {
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

    // Sections address live chunks, which only exist for the current revision — a
    // superseded body was never chunked under its own headings.
    if (
      (args.sections !== undefined || args.outline === true) &&
      (args.rev !== undefined || args.as_of !== undefined)
    ) {
      throw new Error(
        "sections address the current revision's chunks, which a past revision does not have; " +
          "drop `sections`/`outline`, or drop `rev`/`as_of` and narrow the current body.",
      );
    }
  }

  private narrow(node: Record<string, unknown>, id: string, sections?: string[]): void {
    const outline = this.chunks.sections(id);

    node.outline = outline;
    // Whatever is asked for, it is a slice of the body; the raw source of a code
    // mirror is not addressable by heading and would defeat the narrowing.
    delete node.source;

    if (sections === undefined) {
      delete node.content;

      return;
    }

    const picked = this.chunks.sectionText(id, sections);

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
