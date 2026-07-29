import { inject } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { HintsService } from "@/application/services";
import { MirrorRepo } from "@/db/repositories";
import { McpTool, tool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { metadata } from "@/presentation/mcp/tools/mirror-status/metadata";

@tool()
export class MirrorStatusTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    private readonly mirror: MirrorRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const hints = await this.hints.getUnknownSessionHints(args.session_id, null);
    const sources = this.mirror.sourceStatus(this.clock.now(), args.source_id);
    const out: Record<string, unknown> = { sources };

    if (hints.length) out.hints = hints;

    return out;
  }
}
