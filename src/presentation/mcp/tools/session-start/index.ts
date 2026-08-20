import { inject } from "tsyringe";
import { START_SESSION, type StartSession } from "@/application/use-cases";
import { ClientIdentity } from "@/runtime/client-identity";
import { McpTool, tool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { metadata } from "@/presentation/mcp/tools/session-start/metadata";

type Schema = (typeof metadata)["schema"];

interface ToolResponse {
  session_id: string;
  project?: string | null;
  working_set: Record<string, unknown>;
  hints: string[];
  context_notes?: string[];
}

@tool()
export class SessionStartTool implements McpTool<Schema, ToolResponse> {
  constructor(
    @inject(START_SESSION) private readonly start: StartSession,
    private readonly identity: ClientIdentity,
  ) {}

  public getMetadata = () => metadata;

  public async invoke(args: ToolArgs<Schema>): Promise<ToolResponse> {
    const { session_id, project, working_set, notes } = await this.start.invoke({
      project: args.project ?? null,
      client: this.identity.get(),
    });

    return {
      project,
      session_id,
      working_set,
      hints: ["Search before writing. Prefer update/link over creating near-duplicates."],
      ...(notes.length ? { context_notes: notes } : {}),
    };
  }

  // The working set is a surfacing: its ids join against a later `get` like a `search`
  // row's do.
  public describeEvent(_args: ToolArgs<Schema>, result: ToolResponse) {
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
