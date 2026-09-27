import { inject } from "tsyringe";
import {
  REGISTER_SOURCE,
  SESSION_HINTS,
  type RegisterSource,
  type SessionHints,
} from "@/application/use-cases";
import { McpTool, tool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { metadata } from "@/presentation/mcp/tools/source-register/metadata";

type Schema = (typeof metadata)["schema"];

@tool()
export class SourceRegisterTool implements McpTool<Schema, unknown> {
  public getMetadata = () => metadata;

  constructor(
    @inject(SESSION_HINTS) private readonly sessionHints: SessionHints,
    @inject(REGISTER_SOURCE) private readonly register: RegisterSource,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<unknown> {
    const { hints } = await this.sessionHints.invoke({ session_id: args.session_id });
    const { source } = await this.register.invoke({
      id: args.id,
      kind: args.kind,
      label: args.label,
      project: args.project,
      freshness_hours: args.freshness_hours,
      recipe: args.recipe,
      enabled: args.enabled,
    });

    return hints.length ? { source, hints } : { source };
  }
}
