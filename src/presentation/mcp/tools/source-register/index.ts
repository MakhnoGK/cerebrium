import { inject } from "tsyringe";
import { HintsService } from "@/application/services";
import { REGISTER_SOURCE, type RegisterSource } from "@/application/use-cases";
import { McpTool, tool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { metadata } from "@/presentation/mcp/tools/source-register/metadata";

type Schema = (typeof metadata)["schema"];

@tool()
export class SourceRegisterTool implements McpTool<Schema, unknown> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    @inject(REGISTER_SOURCE) private readonly register: RegisterSource,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<unknown> {
    const hints = await this.hints.getSessionHints(args.session_id);
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
