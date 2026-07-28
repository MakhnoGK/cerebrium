import { inject } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { HintsService } from "@/application/services";
import { MirrorRepo } from "@/db/repositories";
import { ToolArgs } from "@/tools/context";
import { McpTool } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { metadata } from "@/tools/source-register/metadata";

@tool()
export class SourceRegisterTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    private readonly mirror: MirrorRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const hints = await this.hints.getUnknownSessionHints(args.session_id, null);

    const source = this.mirror.registerSource({
      id: args.id,
      kind: args.kind,
      label: args.label ?? null,
      project: args.project ?? null,
      freshness_hours: args.freshness_hours ?? null,
      recipe: args.recipe ?? null,
      enabled: args.enabled,
      ts: this.clock.now(),
    });

    return hints.length ? { source, hints } : { source };
  }
}
