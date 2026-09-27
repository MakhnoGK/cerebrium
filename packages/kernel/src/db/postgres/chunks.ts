import { injectable } from "tsyringe";
import type { NodeSection } from "@cerebrium/contracts/types";
import type { ChunksRepo } from "@/domain/ports/storage";
import { PgBaseRepo } from "@/db/postgres/base";
import { matchesSection, sectionName } from "@/core/chunk";

@injectable()
export class PgChunksRepo extends PgBaseRepo implements ChunksRepo {
  private liveChunks(nodeId: string): Promise<{ heading_path: string | null; text: string }[]> {
    return this.all(
      `SELECT heading_path, text FROM chunks
       WHERE node_id = @nodeId AND stale = 0
       ORDER BY seq`,
      { nodeId },
    );
  }

  async sections(nodeId: string): Promise<NodeSection[]> {
    const order: string[] = [];
    const chars = new Map<string, number>();

    for (const chunk of await this.liveChunks(nodeId)) {
      const section = sectionName(chunk.heading_path);
      const seen = chars.get(section);

      if (seen === undefined) order.push(section);
      chars.set(section, (seen ?? 0) + chunk.text.length);
    }

    return order.map((section) => ({ section, chars: chars.get(section) ?? 0 }));
  }

  async sectionText(
    nodeId: string,
    requested: string[],
  ): Promise<{ text: string; matched: string[]; missing: string[] }> {
    const matched = new Set<string>();
    const kept: string[] = [];

    for (const chunk of await this.liveChunks(nodeId)) {
      const hit = requested.find((request) => matchesSection(chunk.heading_path, request));

      if (hit !== undefined) {
        matched.add(hit);
        kept.push(chunk.text);
      }
    }

    return {
      text: kept.join("\n\n"),
      matched: requested.filter((request) => matched.has(request)),
      missing: requested.filter((request) => !matched.has(request)),
    };
  }
}
