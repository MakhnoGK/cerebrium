import { inject, injectable } from "tsyringe";
import { NODES_REPO_TOKEN, type NodesRepo } from "@/domain/ports/storage";
import { ConsolidationThresholdsConfig } from "@/infrastructure/config";

export interface HandMaintained {
  revisions: number;
  inbound: number;
}

@injectable()
export class NodeProtectionService {
  constructor(
    @inject(NODES_REPO_TOKEN) private readonly nodes: NodesRepo,
    private readonly thresholds: ConsolidationThresholdsConfig,
  ) {}

  async handMaintained(id: string): Promise<HandMaintained | null> {
    const profile = await this.nodes.collapseProfile(id);

    if (!profile) return null;

    const { revisions, inbound } = profile;

    return revisions >= this.thresholds.protectRevisions ||
      inbound >= this.thresholds.protectInbound
      ? { revisions, inbound }
      : null;
  }
}
