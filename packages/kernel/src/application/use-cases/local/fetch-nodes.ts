import { inject } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import {
  CHUNKS_REPO_TOKEN,
  CODE_REPO_TOKEN,
  NODES_REPO_TOKEN,
  STORE_TOKEN,
  type ChunksRepo,
  type CodeRepo,
  type NodesRepo,
  type Store,
} from "@/domain/ports/storage";
import { USE_RECORDER_TOKEN, type UseRecorder } from "@/domain/ports/use-recorder";
import { CodeReadService } from "@/application/services";
import {
  FETCH_NODES,
  useCase,
  type FetchNodes,
  type FetchNodesArgs,
  type FetchNodesResult,
} from "@/application/use-cases/contracts";

@useCase(FETCH_NODES)
export class LocalFetchNodes implements FetchNodes {
  constructor(
    @inject(NODES_REPO_TOKEN) private readonly nodes: NodesRepo,
    @inject(CODE_REPO_TOKEN) private readonly code: CodeRepo,
    @inject(CHUNKS_REPO_TOKEN) private readonly chunks: ChunksRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
    @inject(USE_RECORDER_TOKEN) private readonly uses: UseRecorder,
    @inject(STORE_TOKEN) private readonly store: Store,
    private readonly branches: CodeReadService,
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
        const symbol = await this.symbol(id, args);

        if (symbol) nodes.push(symbol);
        else not_found.push(id);

        continue;
      }

      // Under as_of the node has to have existed and still been valid then; a node that was
      // not yet written, or already invalidated, is simply absent from that view.
      const past = args.as_of === undefined ? undefined : await this.nodes.stateAt(id, args.as_of);

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
        const detail = await this.code.symbolDetail(id);

        if (detail) {
          // For a code mirror, `get` is the sanctioned place to return the raw source
          // slice + structured facets (search/code_lookup return envelopes only).
          const { source, ...facets } = detail;
          node.symbol = facets;
          node.source = source;
        }
      }

      const window = await this.nodes.eventWindow(id);

      if (window?.event_from != null) node.event_from = window.event_from;
      if (window?.event_to != null) node.event_to = window.event_to;

      if (past) {
        node.content = past.content;
        node.shown_rev = past.rev;
      }

      if (args.rev !== undefined) {
        const old = await this.nodes.revisionContent(id, args.rev);

        if (old === undefined) {
          throw new Error(`node ${id} has no revision ${args.rev}.`);
        }

        node.content = old;
        node.shown_rev = args.rev;
      }

      if (args.include_revisions) {
        node.revisions = await this.nodes.listRevisions(id);
      }

      if (narrowing) {
        await this.narrow(node, id, args.sections);
      }

      nodes.push(node);
      used.push(id);
    }

    await this.uses.recordUse(used, this.clock.now());

    return { nodes, not_found, used };
  }

  // A symbol of the per-branch index lives outside `nodes`. It has one revision and no
  // headings, so the narrowing and history options have nothing to act on.
  private async symbol(
    id: string,
    args: FetchNodesArgs,
  ): Promise<Record<string, unknown> | undefined> {
    if (!this.store.capabilities.branchCode) return undefined;

    const node = await this.branches.fetch(id, args.code_context);

    if (!node) return undefined;

    if (args.sections !== undefined || args.outline === true) {
      throw new Error(`symbol ${id} has no sections; fetch it without \`sections\`/\`outline\`.`);
    }

    return node;
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

  private async narrow(
    node: Record<string, unknown>,
    id: string,
    sections?: string[],
  ): Promise<void> {
    const outline = await this.chunks.sections(id);

    node.outline = outline;
    // Whatever is asked for, it is a slice of the body; the raw source of a code
    // mirror is not addressable by heading and would defeat the narrowing.
    delete node.source;

    if (sections === undefined) {
      delete node.content;

      return;
    }

    const picked = await this.chunks.sectionText(id, sections);

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
