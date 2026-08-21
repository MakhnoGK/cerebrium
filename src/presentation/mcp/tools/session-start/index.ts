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
}
