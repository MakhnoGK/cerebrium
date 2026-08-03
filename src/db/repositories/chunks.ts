import { injectable } from "tsyringe";
import { BaseRepo } from "@/db/repositories/base";
import { matchesSection, sectionName } from "@/core/chunk";
import type { NodeSection } from "@/core/types";

// Read side of the chunk aggregate: a node's addressable outline and the text behind
// named sections. Chunking itself is a write-path concern and stays in `internal.ts`;
// the kNN join over chunk vectors stays in `search.ts`. Read-only — no transactions.
@injectable()
export class ChunksRepo extends BaseRepo {
  private liveChunks(nodeId: string): { heading_path: string | null; text: string }[] {
    return this.db
      .prepare(
        `SELECT heading_path, text FROM chunks
         WHERE node_id = @node_id AND stale = 0
         ORDER BY seq`,
      )
      .all({ node_id: nodeId }) as { heading_path: string | null; text: string }[];
  }

  // The outline: one entry per distinct heading path, in body order, with the size of
  // everything filed under it. A heading that recurs later in the body folds into its
  // first entry, so a name always addresses the same text `sectionText` would return.
  sections(nodeId: string): NodeSection[] {
    const order: string[] = [];
    const chars = new Map<string, number>();

    for (const chunk of this.liveChunks(nodeId)) {
      const section = sectionName(chunk.heading_path);
      const seen = chars.get(section);

      if (seen === undefined) order.push(section);
      chars.set(section, (seen ?? 0) + chunk.text.length);
    }

    return order.map((section) => ({ section, chars: chars.get(section) ?? 0 }));
  }

  // Text of every live chunk under the requested sections, in body order. `missing`
  // names the requests that addressed nothing, so the caller can say which.
  sectionText(
    nodeId: string,
    requested: string[],
  ): { text: string; matched: string[]; missing: string[] } {
    const chunks = this.liveChunks(nodeId);
    const matched = new Set<string>();
    const kept: string[] = [];

    for (const chunk of chunks) {
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
