import { ulid } from "ulid";
import { EmbeddingService, MemoryService, SessionService } from "@/application/services";
import { McpTool, tool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { metadata } from "@/presentation/mcp/tools/session-start/metadata";

interface ToolResponse {
  session_id: string;
  project?: string | null;
  working_set: Record<string, unknown>;
  hints: string[];
  context_notes?: string[];
}

@tool()
export class SessionStartTool implements McpTool<(typeof metadata)["schema"], ToolResponse> {
  constructor(
    private readonly sessionService: SessionService,
    private readonly memoryService: MemoryService,
    private readonly embeddingService: EmbeddingService,
  ) {}

  public getMetadata = () => metadata;

  public async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<ToolResponse> {
    const now = new Date().toISOString();
    const sessionId = ulid();
    const project = args.project ?? null;

    await this.sessionService.ensureSession(sessionId, project, now);

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

  public describeEvent(_args: ToolArgs<(typeof metadata)["schema"]>, result: ToolResponse) {
    return { session_id: result.session_id, detail: { project: result.project ?? null } };
  }
}
