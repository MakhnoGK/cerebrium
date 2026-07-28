import { inject } from "tsyringe";
import { MirrorRepo } from "@/db/repositories";
import { ToolArgs } from "@/tools/context";
import { McpTool } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { metadata } from "@/tools/mirror-status/metadata";
import { CLOCK_TOKEN, type Clock } from "@/tools/services/clock.service";
import { HintsService } from "@/tools/services/hints.service";

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
