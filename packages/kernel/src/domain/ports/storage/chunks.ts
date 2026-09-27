import type { NodeSection } from "@cerebrium/contracts/types";

export const CHUNKS_REPO_TOKEN = Symbol("ChunksRepo");

export interface ChunksRepo {
  sections(nodeId: string): Promise<NodeSection[]>;
  sectionText(
    nodeId: string,
    requested: string[],
  ): Promise<{ text: string; matched: string[]; missing: string[] }>;
}
