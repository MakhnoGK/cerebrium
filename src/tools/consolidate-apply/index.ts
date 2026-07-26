import { ToolArgs, touchOrCreate } from "@/tools/context";
import { McpTool } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { metadata } from "@/tools/consolidate-apply/metadata";

@tool()
export class ConsolidateApplyTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const hints = touchOrCreate(this.ctx, args.session_id);
    const candidate = this.ctx.repo.getCandidate(args.id);

    if (!candidate) throw new Error(`no consolidation candidate ${args.id}.`);
    if (candidate.status !== "pending") {
      throw new Error(`candidate ${args.id} is already ${candidate.status}.`);
    }

    const now = this.ctx.now();

    if (args.decision === "reject") {
      this.ctx.repo.resolveCandidate(args.id, "dismissed", args.session_id, now);
      this.ctx.repo.logEvent(
        "consolidate_apply",
        args.session_id,
        null,
        { id: args.id, decision: "reject" },
        now,
      );

      const rejected: Record<string, unknown> = { ok: true, id: args.id, status: "dismissed" };
      if (hints.length) rejected.hints = hints;

      return rejected;
    }

    if (candidate.kind === "link") {
      const [src, dst] = candidate.member_ids;

      if (!src || !dst) throw new Error(`link candidate ${args.id} is malformed.`);
      this.ctx.repo.insertEdge(
        src,
        dst,
        "similar_to",
        "system",
        args.session_id,
        now,
        candidate.score,
      );
      this.ctx.repo.resolveCandidate(args.id, "applied", args.session_id, now);
    } else if (candidate.kind === "distill") {
      const result = args.override ?? candidate.proposal;

      if (!result) {
        throw new Error(
          `distill candidate ${args.id} has no proposal — provide override {title,summary,body}.`,
        );
      }

      this.ctx.repo.applyDistillation({
        title: result.title,
        content: result.body,
        project: candidate.project,
        sourceIds: candidate.member_ids,
        session_id: args.session_id,
        ts: now,
      });
      this.ctx.repo.resolveCandidate(args.id, "applied", args.session_id, now);
    } else if (candidate.kind === "merge") {
      const survivor = candidate.canonical_id;
      const loser = candidate.member_ids.find((mid) => mid !== survivor);

      if (!survivor || !loser) throw new Error(`merge candidate ${args.id} is malformed.`);
      const merged = args.override ?? candidate.proposal;

      this.ctx.repo.applyMerge({
        survivorId: survivor,
        loserId: loser,
        session_id: args.session_id,
        ts: now,
        merged: merged ? { title: merged.title, body: merged.body } : undefined,
      });
      this.ctx.repo.resolveCandidate(args.id, "applied", args.session_id, now);
    } else {
      // prune: soft-invalidate the dead mirror node
      const [target] = candidate.member_ids;
      if (!target) throw new Error(`prune candidate ${args.id} is malformed.`);

      this.ctx.repo.invalidateNode(target, { ts: now, session_id: args.session_id });
      this.ctx.repo.resolveCandidate(args.id, "applied", args.session_id, now);
    }

    this.ctx.repo.logEvent(
      "consolidate_apply",
      args.session_id,
      null,
      { id: args.id, decision: "accept", kind: candidate.kind },
      now,
    );

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
