import { TypeOf, z, ZodObject } from "zod";
import type { Ctx } from "@/tools/context";
import { touchOrCreate } from "@/tools/context";
import { AbstractTool, ToolName } from "@/tools/contracts";

export class ConsolidateApplyTool extends AbstractTool {
  name = ToolName.CONSOLIDATE_APPLY;

  description =
    "Resolve a pending consolidation candidate from `consolidate_suggest`. reject dismisses it (the exact cluster is " +
    "never re-proposed). accept applies it: a `link` candidate writes the system similar_to edge between its members; " +
    "a `distill` candidate writes a durable semantic fact from its `override` (or its generated proposal), links it " +
    "`derived_from` each source, and stamps the sources consolidated; a `merge` candidate folds the duplicate into the " +
    "canonical survivor — optionally rewriting it from `override`/proposal — re-points authored edges, and supersedes " +
    "the loser; a `prune` candidate soft-invalidates a dead mirror node. Superseded/consolidated/pruned nodes stay " +
    "queryable via history. Idempotent per candidate — one already applied or dismissed cannot be resolved again.";

  schema = {
    session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
    id: z.string().describe("The consolidation candidate id (from consolidate_suggest)."),
    decision: z
      .enum(["accept", "reject"])
      .describe("accept: apply the consolidation. reject: dismiss it (never re-proposed)."),
    override: z
      .object({
        title: z.string().min(1),
        summary: z.string().min(1),
        body: z.string().min(1),
      })
      .optional()
      .describe(
        "For accepting a distill/merge candidate: the summary/merged body to write, overriding any generated proposal. Required for distill when the candidate has no proposal (e.g. the manual provider); optional for merge.",
      ),
  };

  async invoke(ctx: Ctx, args: TypeOf<ZodObject<typeof this.schema>>): Promise<unknown> {
    const hints = touchOrCreate(ctx, args.session_id);
    const candidate = ctx.repo.getCandidate(args.id);

    if (!candidate) throw new Error(`no consolidation candidate ${args.id}.`);
    if (candidate.status !== "pending") {
      throw new Error(`candidate ${args.id} is already ${candidate.status}.`);
    }

    const now = ctx.now();

    if (args.decision === "reject") {
      ctx.repo.resolveCandidate(args.id, "dismissed", args.session_id, now);
      ctx.repo.logEvent(
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
      ctx.repo.insertEdge(src, dst, "similar_to", "system", args.session_id, now, candidate.score);
      ctx.repo.resolveCandidate(args.id, "applied", args.session_id, now);
    } else if (candidate.kind === "distill") {
      const result = args.override ?? candidate.proposal;

      if (!result) {
        throw new Error(
          `distill candidate ${args.id} has no proposal — provide override {title,summary,body}.`,
        );
      }

      ctx.repo.applyDistillation({
        title: result.title,
        content: result.body,
        project: candidate.project,
        sourceIds: candidate.member_ids,
        session_id: args.session_id,
        ts: now,
      });
      ctx.repo.resolveCandidate(args.id, "applied", args.session_id, now);
    } else if (candidate.kind === "merge") {
      const survivor = candidate.canonical_id;
      const loser = candidate.member_ids.find((mid) => mid !== survivor);

      if (!survivor || !loser) throw new Error(`merge candidate ${args.id} is malformed.`);
      const merged = args.override ?? candidate.proposal;

      ctx.repo.applyMerge({
        survivorId: survivor,
        loserId: loser,
        session_id: args.session_id,
        ts: now,
        merged: merged ? { title: merged.title, body: merged.body } : undefined,
      });
      ctx.repo.resolveCandidate(args.id, "applied", args.session_id, now);
    } else {
      // prune: soft-invalidate the dead mirror node
      const [target] = candidate.member_ids;
      if (!target) throw new Error(`prune candidate ${args.id} is malformed.`);

      ctx.repo.invalidateNode(target, { ts: now, session_id: args.session_id });
      ctx.repo.resolveCandidate(args.id, "applied", args.session_id, now);
    }

    ctx.repo.logEvent(
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
