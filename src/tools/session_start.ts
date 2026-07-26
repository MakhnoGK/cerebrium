import { z } from "zod";
import { ulid } from "ulid";
import type { ToolArgs } from "@/tools/context";
import { AbstractTool, ToolName } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { Context } from "@/core/context";
import { MemoryService } from "@/tools/services/memory.service";
import { SessionService } from "@/tools/services/session.service";
import { EmbeddingService } from "@/tools/services/embedding.service";

interface ToolResponse {
  session_id: string;
  project?: string | null;
  working_set: Record<string, unknown>;
  hints: string[];
  context_notes?: string[];
}

@tool()
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

  constructor(
    protected readonly ctx: Context,
    private readonly sessionService: SessionService,
    private readonly memoryService: MemoryService,
    private readonly embeddingService: EmbeddingService,
  ) {
    super(ctx);
  }

  public async invoke(args: ToolArgs<typeof this.schema>): Promise<ToolResponse> {
    const now = new Date().toISOString();
    const sessionId = ulid();
    const project = args.project ?? null;

    await this.sessionService.ensureSession(sessionId, project, now);

    // TODO: Custom logger
    // this.ctx.repo.logEvent("session_start", sessionId, null, { project: project }, this.ctx.now());

    const workingSet = this.memoryService.getWorkingSet(project ?? undefined);
    const notes = this.embeddingService.getEmbeddingNotes();

    return {
      project,
      session_id: sessionId,
      working_set: workingSet,
      hints: ["Search before writing. Prefer update/link over creating near-duplicates."],
      ...(notes.length ? { context_notes: notes } : {}),
    };
  }
}
