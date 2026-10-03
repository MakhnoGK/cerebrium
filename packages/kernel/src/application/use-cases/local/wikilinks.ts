import { inject } from "tsyringe";
import { projectFamily } from "@cerebrium/contracts/graph";
import { MemoryKind } from "@cerebrium/contracts/vocab";
import type { WikilinkDangler, WikilinkFixResult } from "@cerebrium/contracts/wikilinks";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import {
  CONSOLIDATION_REPO_TOKEN,
  NODES_REPO_TOKEN,
  SEARCH_REPO_TOKEN,
  type ConsolidationRepo,
  type NodesRepo,
  type SearchRepo,
} from "@/domain/ports/storage";
import { NodeReferenceService, WikilinkResolverService } from "@/application/services";
import {
  FIX_WIKILINK,
  LIST_DANGLERS,
  useCase,
  type FixWikilink,
  type FixWikilinkArgs,
  type ListDanglers,
  type ListDanglersArgs,
} from "@/application/use-cases/contracts";
import { parseTextQuery } from "@/core/fts";
import { idTarget, rewriteWikilink, slugify, wikilinks } from "@/core/wikilinks";

const DEFAULT_LIMIT = 500;
const SUGGESTIONS = 3;

type Body = Awaited<ReturnType<ConsolidationRepo["authoredBodies"]>>[number];

@useCase(LIST_DANGLERS)
export class LocalListDanglers implements ListDanglers {
  constructor(
    @inject(CONSOLIDATION_REPO_TOKEN) private readonly consolidation: ConsolidationRepo,
    @inject(SEARCH_REPO_TOKEN) private readonly search: SearchRepo,
    private readonly resolver: WikilinkResolverService,
  ) {}

  async invoke(args: ListDanglersArgs): Promise<WikilinkDangler[]> {
    const limit = args.limit ?? DEFAULT_LIMIT;
    const bodies = await this.consolidation.authoredBodies();
    const links = await this.resolver.index(bodies);
    const byId = new Map(bodies.map((body) => [body.id, body]));
    const ignored = new Set(
      (await this.consolidation.ignoredWikilinks()).map((i) => `${i.node_id}\0${i.link}`),
    );
    const out: WikilinkDangler[] = [];

    for (const body of bodies) {
      for (const link of wikilinks(body.content)) {
        if (idTarget(link.slug) !== null || ignored.has(`${body.id}\0${link.slug}`)) continue;

        const outcome = await links.resolve(link.slug);

        if ("id" in outcome) continue;

        out.push({
          node_id: body.id,
          node_title: body.title,
          project: body.project,
          link: link.raw,
          reason: outcome.dangling,
          editable: body.kind === MemoryKind.SEMANTIC,
          suggestions: outcome.candidates.length
            ? outcome.candidates
                .filter((id) => byId.has(id))
                .map((id) => ({ id, title: byId.get(id)!.title }))
            : await this.textMatches(body, link.raw),
        });

        if (out.length >= limit) return out;
      }
    }

    return out;
  }

  private async textMatches(body: Body, link: string): Promise<{ id: string; title: string }[]> {
    const text = parseTextQuery(link);

    if (text === null) return [];

    const family = projectFamily(body.project);
    const { rows } = await this.search.search({
      text,
      kinds: [MemoryKind.SEMANTIC, MemoryKind.EPISODIC],
      history: false,
      cap: SUGGESTIONS * 4,
    });

    return rows
      .filter((row) => {
        const other = projectFamily(row.project);

        return row.id !== body.id && (family === null || other === null || family === other);
      })
      .slice(0, SUGGESTIONS)
      .map((row) => ({ id: row.id, title: row.title }));
  }
}

@useCase(FIX_WIKILINK)
export class LocalFixWikilink implements FixWikilink {
  constructor(
    @inject(NODES_REPO_TOKEN) private readonly nodes: NodesRepo,
    @inject(CONSOLIDATION_REPO_TOKEN) private readonly consolidation: ConsolidationRepo,
    private readonly references: NodeReferenceService,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async invoke(args: FixWikilinkArgs): Promise<WikilinkFixResult> {
    const now = this.clock.now();

    await this.references.requireLive(args.node_id, "note");

    if (args.action === "ignore") {
      await this.consolidation.ignoreWikilink(args.node_id, slugify(args.link), now);

      return { node_id: args.node_id, action: args.action, rewritten: 0 };
    }

    const note = await this.nodes.envelope(args.node_id);

    if (note?.kind !== MemoryKind.SEMANTIC) {
      throw new Error(
        "only a semantic note's links can be rewritten; an episodic note is write-once, so ignore the link instead.",
      );
    }

    let target: string | null = null;

    if (args.action === "rewrite") {
      if (!args.target_id) throw new Error("`rewrite` needs `target_id`.");

      await this.references.requireLive(args.target_id, "target");
      target = args.target_id;
    }

    const current = await this.nodes.stateAt(args.node_id, now);
    const { content, count } = rewriteWikilink(current?.content ?? "", args.link, target);

    if (count === 0) throw new Error(`note ${args.node_id} no longer links [[${args.link}]].`);

    await this.nodes.addRevision(args.node_id, {
      content,
      session_id: args.session_id,
      reason:
        target === null
          ? `unlinked [[${args.link}]] (dashboard)`
          : `wikilink [[${args.link}]] -> [[${target}]] (dashboard)`,
      ts: now,
    });

    return { node_id: args.node_id, action: args.action, rewritten: count };
  }
}
