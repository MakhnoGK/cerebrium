import { inject } from "tsyringe";
import {
  SESSION_HINTS,
  UPSERT_MIRRORS,
  type SessionHints,
  type UpsertMirrors,
} from "@/application/use-cases";
import { McpTool, tool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { metadata } from "@/presentation/mcp/tools/mirror-upsert/metadata";

type Schema = (typeof metadata)["schema"];

@tool()
export class MirrorUpsertTool implements McpTool<Schema, unknown> {
  public getMetadata = () => metadata;

  constructor(
    @inject(SESSION_HINTS) private readonly sessionHints: SessionHints,
    @inject(UPSERT_MIRRORS) private readonly upsert: UpsertMirrors,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<unknown> {
    const { hints } = await this.sessionHints.invoke({ session_id: args.session_id });
    const { result, notes } = await this.upsert.invoke({
      session_id: args.session_id,
      source_id: args.source_id,
      items: args.items,
    });

    const out: Record<string, unknown> = { ...result };

    if (hints.length) out.hints = hints;
    if (notes.length) out.context_notes = notes;

    return out;
  }
}
