import { z } from "zod";
import type { Ctx, ToolArgs } from "@/tools/context";
import { newId } from "@/core/ids";
import { estimateTokensOf } from "@/core/tokens";
import { embeddingNotes } from "@/tools/notes";
import type { Envelope } from "@/db/repo";
import { AbstractTool, ToolName } from "@/tools/contracts";

interface ToolResponse {
  session_id: string;
  project?: string | null;
  working_set: Record<string, unknown>;
  hints: string[];
  context_notes?: string[];
}

export class SessionStartTool extends AbstractTool {
  name = ToolName.SESSION_START;

  description =
    "Begin a work session. Call this FIRST, before any other memory tool. Returns a fresh `session_id` (pass it to " +
    "every other tool) plus a compact working set for the project: recent semantic facts/decisions, the last couple " +
    "of checkpoints (with full content, so you know where you left off), open tasks, and a stats line — all trimmed to " +
    "a small token budget. Read this to orient before you start.";

  schema = {
    project: z
      .string()
      .optional()
      .describe("Project scope to focus the working set; omit for a global view."),
  };

  public async invoke(ctx: Ctx, args: ToolArgs<typeof this.schema>): Promise<ToolResponse> {
    const sessionId = newId();
    const project = args.project;
    ctx.repo.ensureSession(sessionId, project ?? null, ctx.now());

    let spent = 0;
    const budget = ctx.workingSetBudget;

    const fits = (item: unknown): boolean => {
      const t = estimateTokensOf(item);
      if (spent + t > budget) return false;
      spent += t;
      return true;
    };

    const take = <T>(items: T[]): T[] => items.filter(fits);

    const working_set: Record<string, unknown> = {};
    if (project !== undefined) {
      working_set.semantic = take<Envelope>(ctx.repo.validSemantic(project, 15));
    } else {
      working_set.recent = take<Envelope>(ctx.repo.recentValid(undefined, 15));
    }

    working_set.checkpoints = take(ctx.repo.lastCheckpoints(project, 2));
    working_set.tasks = take<Envelope>(ctx.repo.validTasks(project, 10));

    // Freshness hook: nudge the agent to re-sync external mirror sources that are past
    // their freshness window. Only registered, enabled, stale sources; omitted entirely
    // when there are none (a deployment with no sources sees no change).
    const stale = ctx.repo
      .sourceStatus(ctx.now())
      .filter((s) => s.stale)
      .map((s) => ({ id: s.id, label: s.label, hours_stale: s.hours_stale }));

    if (stale.length) working_set.stale_sources = take(stale);

    working_set.stats = ctx.repo.stats();

    ctx.repo.logEvent("session_start", sessionId, null, { project: project ?? null }, ctx.now());

    const notes = embeddingNotes(ctx.repo);

    return {
      session_id: sessionId,
      project: project ?? null,
      working_set,
      hints: ["Search before writing. Prefer update/link over creating near-duplicates."],
      ...(notes.length ? { context_notes: notes } : {}),
    };
  }
}
