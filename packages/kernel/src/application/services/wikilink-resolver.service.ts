import { inject, injectable } from "tsyringe";
import {
  CONSOLIDATION_REPO_TOKEN,
  NODES_REPO_TOKEN,
  type ConsolidationRepo,
  type NodesRepo,
} from "@/domain/ports/storage";
import { NodeReferenceService } from "@/application/services/node-reference.service";
import { idTarget, resolveTarget, slugIndexOf, type SlugIndex } from "@/core/wikilinks";

export type WikilinkOutcome =
  { id: string } | { dangling: "unknown" | "ambiguous"; candidates: string[] };

export interface WikilinkIndex {
  resolve(slug: string): Promise<WikilinkOutcome>;
}

@injectable()
export class WikilinkResolverService {
  constructor(
    @inject(CONSOLIDATION_REPO_TOKEN) private readonly consolidation: ConsolidationRepo,
    @inject(NODES_REPO_TOKEN) private readonly nodes: NodesRepo,
    private readonly references: NodeReferenceService,
  ) {}

  // A title link resolves against the live titles, then the titles a live node used to
  // carry, then a retired title followed forward to its one live successor.
  async index(live: { id: string; title: string }[]): Promise<WikilinkIndex> {
    const current = slugIndexOf(live);
    const former = slugIndexOf(await this.consolidation.formerTitles());
    const retired = slugIndexOf(await this.consolidation.retiredAuthoredTitles());

    return {
      resolve: (slug) => {
        const id = idTarget(slug);

        return id === null ? this.byTitle(slug, current, former, retired) : this.byId(id);
      },
    };
  }

  private async byTitle(
    slug: string,
    current: SlugIndex,
    former: SlugIndex,
    retired: SlugIndex,
  ): Promise<WikilinkOutcome> {
    for (const index of [current, former]) {
      const hit = resolveTarget(index, slug);

      if (hit.kind === "exact" || hit.kind === "prefix") return { id: hit.id };
      if (hit.kind === "ambiguous") return { dangling: "ambiguous", candidates: hit.ids };
    }

    const gone = resolveTarget(retired, slug);

    if (gone.kind !== "exact" && gone.kind !== "prefix") {
      return { dangling: "unknown", candidates: [] };
    }

    const successors = await this.references.terminalLiveSuccessors(gone.id);

    return successors.length === 1
      ? { id: successors[0]! }
      : { dangling: successors.length ? "ambiguous" : "unknown", candidates: successors };
  }

  private async byId(id: string): Promise<WikilinkOutcome> {
    const state = await this.nodes.referenceState(id);

    if (state === "live") return { id };
    if (state === "missing") return { dangling: "unknown", candidates: [] };

    const successors = await this.references.terminalLiveSuccessors(id);

    return successors.length === 1
      ? { id: successors[0]! }
      : { dangling: successors.length ? "ambiguous" : "unknown", candidates: successors };
  }
}
