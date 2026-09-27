import type { Neighbor, NeighborStub } from "@cerebrium/contracts/types";
import type { EdgeType } from "@cerebrium/contracts/vocab";

export interface SubgraphEdge {
  src: string;
  dst: string;
  type: EdgeType;
  weight: number;
}

export const EDGES_REPO_TOKEN = Symbol("EdgesRepo");

export interface EdgesRepo {
  insertEdge(
    src: string,
    dst: string,
    type: EdgeType,
    provenance: "agent" | "system",
    session_id: string,
    ts: string,
    weight?: number,
  ): Promise<void>;
  insertSystemSimilarityIfLive(
    src: string,
    dst: string,
    session_id: string,
    ts: string,
    weight: number,
  ): Promise<boolean>;
  insertDuplicateOfIfLive(
    duplicate: string,
    representative: string,
    session_id: string,
    ts: string,
    weight: number,
  ): Promise<boolean>;
  insertSystemReferenceIfUnconnected(
    src: string,
    dst: string,
    session_id: string,
    ts: string,
  ): Promise<boolean>;
  pairIsConnected(a: string, b: string): Promise<boolean>;
  insertSystemDocumentsIfLive(
    note: string,
    symbol: string,
    session_id: string,
    ts: string,
  ): Promise<boolean>;
  invalidateSystemSimilaritiesOf(id: string, ts: string): Promise<number>;
  invalidateEdge(src: string, dst: string, type: EdgeType, ts: string): Promise<void>;
  edgesOf(id: string): Promise<NeighborStub[]>;
  neighborsOf(parentIds: string[]): Promise<Neighbor[]>;
  subgraphFrom(
    seedIds: string[],
    opts: { depth: number; cap: number; types: string[]; asOf?: string; validAt?: string },
  ): Promise<SubgraphEdge[]>;
  supersededInfo(ids: string[]): Promise<Map<string, { by: string; at: string }>>;
  supersedesPairs(ids: string[]): Promise<Set<string>>;
  duplicatePairs(ids: string[]): Promise<Set<string>>;
  liveSuccessorsOf(id: string): Promise<string[]>;
}
