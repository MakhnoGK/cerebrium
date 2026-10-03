import { inject } from "tsyringe";
import { MemoryKind } from "@cerebrium/contracts/vocab";
import type {
  WikilinkDangler,
  WikilinkFixResult,
  WikilinkVerdict,
} from "@cerebrium/contracts/wikilinks";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import {
  CONSOLIDATION_REPO_TOKEN,
  type ConsolidationRepo,
  type WikilinkVerdictRow,
} from "@/domain/ports/storage";
import { NodeReferenceService, WikilinkDanglerService } from "@/application/services";
import {
  FIX_WIKILINK,
  LIST_DANGLERS,
  useCase,
  type FixWikilink,
  type FixWikilinkArgs,
  type ListDanglers,
  type ListDanglersArgs,
} from "@/application/use-cases/contracts";
import { slugify } from "@/core/wikilinks";

const DEFAULT_LIMIT = 500;

@useCase(LIST_DANGLERS)
export class LocalListDanglers implements ListDanglers {
  constructor(
    @inject(CONSOLIDATION_REPO_TOKEN) private readonly consolidation: ConsolidationRepo,
    private readonly danglers: WikilinkDanglerService,
  ) {}

  async invoke(args: ListDanglersArgs): Promise<WikilinkDangler[]> {
    const limit = args.limit ?? DEFAULT_LIMIT;
    const { bodies, danglers } = await this.danglers.scan();
    const byId = new Map(bodies.map((body) => [body.id, body]));
    const verdicts = new Map(
      (await this.consolidation.wikilinkVerdicts()).map((v) => [`${v.node_id}\0${v.link}`, v]),
    );
    const out: WikilinkDangler[] = [];

    for (const dangler of danglers.slice(0, limit)) {
      const { body, link } = dangler;
      const verdict = verdicts.get(`${body.id}\0${link.slug}`);

      out.push({
        node_id: body.id,
        node_title: body.title,
        project: body.project,
        link: link.raw,
        reason: dangler.reason,
        editable: body.kind === MemoryKind.SEMANTIC,
        suggestions: dangler.candidates.length
          ? dangler.candidates
              .filter((id) => byId.has(id))
              .map((id) => ({ id, title: byId.get(id)!.title }))
          : await this.danglers.textMatches(dangler),
        verdict:
          verdict?.rev === body.rev ? verdictOf(verdict, byId.get(verdict.target_id ?? "")) : null,
      });
    }

    return out;
  }
}

function verdictOf(
  row: WikilinkVerdictRow,
  target: { title: string } | undefined,
): WikilinkVerdict | null {
  if (row.target_id !== null && target === undefined) return null;

  return {
    target: row.target_id === null ? null : { id: row.target_id, title: target!.title },
    confidence: row.confidence === "high" ? "high" : "low",
    reason: row.reason,
    judged_at: row.judged_at,
  };
}

@useCase(FIX_WIKILINK)
export class LocalFixWikilink implements FixWikilink {
  constructor(
    @inject(CONSOLIDATION_REPO_TOKEN) private readonly consolidation: ConsolidationRepo,
    private readonly danglers: WikilinkDanglerService,
    private readonly references: NodeReferenceService,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async invoke(args: FixWikilinkArgs): Promise<WikilinkFixResult> {
    const now = this.clock.now();

    if (args.action === "ignore") {
      await this.references.requireLive(args.node_id, "note");
      await this.consolidation.ignoreWikilink(args.node_id, slugify(args.link), now);

      return { node_id: args.node_id, action: args.action, rewritten: 0 };
    }

    if (args.action === "rewrite" && !args.target_id)
      throw new Error("`rewrite` needs `target_id`.");

    const rewritten = await this.danglers.rewrite({
      node_id: args.node_id,
      link: args.link,
      target: args.action === "rewrite" ? args.target_id! : null,
      session_id: args.session_id,
      via: "dashboard",
      ts: now,
    });

    return { node_id: args.node_id, action: args.action, rewritten };
  }
}
