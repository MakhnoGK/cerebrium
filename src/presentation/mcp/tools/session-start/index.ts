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

    this.sessionService.startSession(sessionId, project, now);

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

  // The working set is a surfacing like any other: its ids join against the ids a later
  // `get` fetched, the same way a `search` row does. Without this a node the agent only
  // ever met here counts as never surfaced.
  public describeEvent(_args: ToolArgs<(typeof metadata)["schema"]>, result: ToolResponse) {
    return {
      session_id: result.session_id,
      detail: { project: result.project ?? null, ids: surfacedNodeIds(result.working_set) },
    };
  }
}

// An allowlist, not a scan: `stale_sources` also carries an `id`, but a source id is not
// a node id.
const NODE_SECTIONS = ["tasks", "checkpoints", "semantic", "recent"];

function surfacedNodeIds(workingSet: Record<string, unknown>): string[] {
  return NODE_SECTIONS.flatMap((section) => {
    const entries = workingSet[section];

    return (Array.isArray(entries) ? entries : [])
      .map(nodeIdOf)
      .filter((id): id is string => id !== null);
  });
}

function nodeIdOf(entry: unknown): string | null {
  const record = entry as { id?: unknown; envelope?: { id?: unknown } };
  const id = record.envelope?.id ?? record.id;

  return typeof id === "string" ? id : null;
}
