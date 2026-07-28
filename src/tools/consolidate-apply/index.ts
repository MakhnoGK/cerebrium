import { inject } from "tsyringe";
import { ConsolidationRepo, EdgesRepo, NodesRepo } from "@/db/repositories";
import { metadata } from "@/tools/consolidate-apply/metadata";
import { ToolArgs } from "@/tools/context";
import { McpTool } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { CLOCK_TOKEN, type Clock } from "@/tools/services/clock.service";
import { HintsService } from "@/tools/services/hints.service";

@tool()
export class ConsolidateApplyTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    private readonly consolidation: ConsolidationRepo,
    private readonly edges: EdgesRepo,
    private readonly nodes: NodesRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const hints = await this.hints.getUnknownSessionHints(args.session_id, null);
    const candidate = this.consolidation.getCandidate(args.id);

    if (!candidate) throw new Error(`no consolidation candidate ${args.id}.`);
    if (candidate.status !== "pending") {
      throw new Error(`candidate ${args.id} is already ${candidate.status}.`);
    }

    const now = this.clock.now();

    if (args.decision === "reject") {
      this.consolidation.resolveCandidate(args.id, "dismissed", args.session_id, now);

      const rejected: Record<string, unknown> = { ok: true, id: args.id, status: "dismissed" };
      if (hints.length) rejected.hints = hints;

      return rejected;
    }

    if (candidate.kind === "link") {
      const [src, dst] = candidate.member_ids;

      if (!src || !dst) throw new Error(`link candidate ${args.id} is malformed.`);
      this.edges.insertEdge(
        src,
        dst,
        "similar_to",
        "system",
        args.session_id,
        now,
        candidate.score,
      );
      this.consolidation.resolveCandidate(args.id, "applied", args.session_id, now);
    } else if (candidate.kind === "distill") {
      const result = args.override ?? candidate.proposal;

      if (!result) {
        throw new Error(
          `distill candidate ${args.id} has no proposal — provide override {title,summary,body}.`,
        );
      }

      this.nodes.applyDistillation({
        title: result.title,
        content: result.body,
        project: candidate.project,
        sourceIds: candidate.member_ids,
        session_id: args.session_id,
        ts: now,
      });
      this.consolidation.resolveCandidate(args.id, "applied", args.session_id, now);
    } else if (candidate.kind === "merge") {
      const survivor = candidate.canonical_id;
      const loser = candidate.member_ids.find((mid) => mid !== survivor);

      if (!survivor || !loser) throw new Error(`merge candidate ${args.id} is malformed.`);
      const merged = args.override ?? candidate.proposal;

      this.nodes.applyMerge({
        survivorId: survivor,
        loserId: loser,
        session_id: args.session_id,
        ts: now,
        merged: merged ? { title: merged.title, body: merged.body } : undefined,
      });
      this.consolidation.resolveCandidate(args.id, "applied", args.session_id, now);
    } else {
      // prune: soft-invalidate the dead mirror node
      const [target] = candidate.member_ids;
      if (!target) throw new Error(`prune candidate ${args.id} is malformed.`);

      this.nodes.invalidateNode(target, { ts: now, session_id: args.session_id });
      this.consolidation.resolveCandidate(args.id, "applied", args.session_id, now);
    }

    const out: Record<string, unknown> = {
      ok: true,
      id: args.id,
      status: "applied",
      kind: candidate.kind,
    };

    if (hints.length) out.hints = hints;

    return out;
  }
}
