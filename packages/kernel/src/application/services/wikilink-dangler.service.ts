import { inject, injectable } from "tsyringe";
import { projectFamily } from "@cerebrium/contracts/graph";
import { MemoryKind } from "@cerebrium/contracts/vocab";
import {
  CONSOLIDATION_REPO_TOKEN,
  NODES_REPO_TOKEN,
  SEARCH_REPO_TOKEN,
  type AuthoredBody,
  type ConsolidationRepo,
  type NodesRepo,
  type SearchRepo,
} from "@/domain/ports/storage";
import { NodeReferenceService } from "@/application/services/node-reference.service";
import { WikilinkResolverService } from "@/application/services/wikilink-resolver.service";
import { parseTextQuery } from "@/core/fts";
import { idTarget, rewriteWikilink, wikilinks } from "@/core/wikilinks";

const TEXT_MATCHES = 3;

export interface Dangler {
  body: AuthoredBody;
  link: { raw: string; slug: string };
  reason: "unknown" | "ambiguous";
  // The live notes an ambiguous title link could mean.
  candidates: string[];
}

// Title links in live notes that resolve to no live note, minus the ones the owner ignored.
@injectable()
export class WikilinkDanglerService {
  constructor(
    @inject(CONSOLIDATION_REPO_TOKEN) private readonly consolidation: ConsolidationRepo,
    @inject(SEARCH_REPO_TOKEN) private readonly search: SearchRepo,
    @inject(NODES_REPO_TOKEN) private readonly nodes: NodesRepo,
    private readonly resolver: WikilinkResolverService,
    private readonly references: NodeReferenceService,
  ) {}

  async scan(): Promise<{ bodies: AuthoredBody[]; danglers: Dangler[] }> {
    const bodies = await this.consolidation.authoredBodies();
    const links = await this.resolver.index(bodies);
    const ignored = new Set(
      (await this.consolidation.ignoredWikilinks()).map((i) => `${i.node_id}\0${i.link}`),
    );
    const danglers: Dangler[] = [];

    for (const body of bodies) {
      for (const link of wikilinks(body.content)) {
        if (idTarget(link.slug) !== null || ignored.has(`${body.id}\0${link.slug}`)) continue;

        const outcome = await links.resolve(link.slug);

        if ("id" in outcome) continue;

        danglers.push({ body, link, reason: outcome.dangling, candidates: outcome.candidates });
      }
    }

    return { bodies, danglers };
  }

  // Notes of the same project family whose text matches the link's words.
  async textMatches(dangler: Dangler): Promise<{ id: string; title: string }[]> {
    const text = parseTextQuery(dangler.link.raw);

    if (text === null) return [];

    const family = projectFamily(dangler.body.project);
    const { rows } = await this.search.search({
      text,
      kinds: [MemoryKind.SEMANTIC, MemoryKind.EPISODIC],
      history: false,
      cap: TEXT_MATCHES * 4,
    });

    return rows
      .filter((row) => {
        const other = projectFamily(row.project);

        return (
          row.id !== dangler.body.id && (family === null || other === null || family === other)
        );
      })
      .slice(0, TEXT_MATCHES)
      .map((row) => ({ id: row.id, title: row.title }));
  }

  // Points every `[[link]]` in a semantic note at `target`, or unlinks it, as a new revision.
  async rewrite(args: {
    node_id: string;
    link: string;
    target: string | null;
    session_id: string;
    via: string;
    ts: string;
  }): Promise<number> {
    await this.references.requireLive(args.node_id, "note");

    const note = await this.nodes.envelope(args.node_id);

    if (note?.kind !== MemoryKind.SEMANTIC) {
      throw new Error(
        "only a semantic note's links can be rewritten; an episodic note is write-once, so ignore the link instead.",
      );
    }

    if (args.target !== null) await this.references.requireLive(args.target, "target");

    const current = await this.nodes.stateAt(args.node_id, args.ts);
    const { content, count } = rewriteWikilink(current?.content ?? "", args.link, args.target);

    if (count === 0) throw new Error(`note ${args.node_id} no longer links [[${args.link}]].`);

    // Must precede the revision: a revision at the same ts does not count as newer.
    await this.consolidation.confirmSettledLinks(args.node_id, args.ts);
    await this.nodes.addRevision(args.node_id, {
      content,
      session_id: args.session_id,
      reason:
        args.target === null
          ? `unlinked [[${args.link}]] (${args.via})`
          : `wikilink [[${args.link}]] -> [[${args.target}]] (${args.via})`,
      ts: args.ts,
    });

    return count;
  }
}
