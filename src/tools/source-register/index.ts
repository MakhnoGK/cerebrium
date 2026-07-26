import { ToolArgs, touchOrCreate } from "@/tools/context";
import { McpTool } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { metadata } from "@/tools/source-register/metadata";

@tool()
export class SourceRegisterTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const hints = touchOrCreate(this.ctx, args.session_id);

    const source = this.ctx.repo.registerSource({
      id: args.id,
      kind: args.kind,
      label: args.label ?? null,
      project: args.project ?? null,
      freshness_hours: args.freshness_hours ?? null,
      recipe: args.recipe ?? null,
      enabled: args.enabled,
      ts: this.ctx.now(),
    });

    this.ctx.repo.logEvent(
      "source_register",
      args.session_id,
      null,
      { id: args.id, kind: args.kind },
      this.ctx.now(),
    );

    return hints.length ? { source, hints } : { source };
  }
}
