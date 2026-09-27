import { inject } from "tsyringe";
import {
  LINK_NODES,
  SESSION_HINTS,
  type LinkNodes,
  type SessionHints,
} from "@/application/use-cases";
import { McpTool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { metadata } from "@/presentation/mcp/tools/link/metadata";

type Schema = (typeof metadata)["schema"];

@tool()
export class LinkTool implements McpTool<Schema, unknown> {
  public getMetadata = () => metadata;

  constructor(
    @inject(SESSION_HINTS) private readonly sessionHints: SessionHints,
    @inject(LINK_NODES) private readonly link: LinkNodes,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<unknown> {
    const { hints } = await this.sessionHints.invoke({ session_id: args.session_id });
    const { notes, ...edge } = await this.link.invoke({
      session_id: args.session_id,
      src: args.src,
      dst: args.dst,
      type: args.type,
      weight: args.weight,
    });

    const out: Record<string, unknown> = { ok: true, ...edge };

    if (hints.length) out.hints = hints;
    if (notes.length) out.context_notes = notes;

    return out;
  }
}
