import { useCaseToken, type UseCase } from "@/application/use-cases/contracts/use-case";
import type { Envelope } from "@/core/types";
import type { EdgeType, MemoryKind } from "@/core/vocab";

export interface NodeLink {
  dst: string;
  type: EdgeType;
}

export interface EventWindow {
  event_from?: string;
  event_to?: string;
}

// A near-duplicate the write probe found, with the confidence band it fell in. Advisory:
// the write always succeeds and the agent decides what to do about it.
export interface SimilarExisting {
  id: string;
  title: string;
  summary: string;
  score: number;
  confidence: "high" | "moderate";
  suggestion: string;
}

export interface WriteMemoryArgs extends EventWindow {
  session_id: string;
  memory_kind: MemoryKind;
  type: string;
  title: string;
  content: string;
  project: string | null;
  parent_node_id: string | null;
  links?: NodeLink[];
}

export interface WriteMemoryResult {
  envelope: Envelope;
  similar_existing: SimilarExisting[];
  reconcile: unknown;
  notes: string[];
}

export type WriteMemory = UseCase<WriteMemoryArgs, WriteMemoryResult>;

export const WRITE_MEMORY = useCaseToken<WriteMemoryArgs, WriteMemoryResult>("WriteMemory");

export interface UpdateMemoryArgs extends EventWindow {
  session_id: string;
  id: string;
  content?: string;
  title?: string;
  reason?: string;
}

export interface UpdateMemoryResult {
  envelope: Envelope;
  notes: string[];
}

export type UpdateMemory = UseCase<UpdateMemoryArgs, UpdateMemoryResult>;

export const UPDATE_MEMORY = useCaseToken<UpdateMemoryArgs, UpdateMemoryResult>("UpdateMemory");

export interface InvalidateMemoryArgs {
  session_id: string;
  id: string;
  superseded_by?: string;
}

export interface EnvelopeResult {
  envelope: Envelope;
}

export type InvalidateMemory = UseCase<InvalidateMemoryArgs, EnvelopeResult>;

export const INVALIDATE_MEMORY = useCaseToken<InvalidateMemoryArgs, EnvelopeResult>(
  "InvalidateMemory",
);

export interface RestoreMemoryArgs {
  session_id: string;
  id: string;
}

export type RestoreMemory = UseCase<RestoreMemoryArgs, EnvelopeResult>;

export const RESTORE_MEMORY = useCaseToken<RestoreMemoryArgs, EnvelopeResult>("RestoreMemory");

export interface LinkNodesArgs {
  session_id: string;
  src: string;
  dst: string;
  type: EdgeType;
  weight?: number;
}

export interface LinkNodesResult {
  src: string;
  dst: string;
  type: EdgeType;
  weight: number;
  notes: string[];
}

export type LinkNodes = UseCase<LinkNodesArgs, LinkNodesResult>;

export const LINK_NODES = useCaseToken<LinkNodesArgs, LinkNodesResult>("LinkNodes");

export interface RecordCheckpointArgs {
  session_id: string;
  title: string;
  summary: string;
  decisions?: string[];
  open_threads?: string[];
  project?: string;
  touched_node_ids?: string[];
}

export type RecordCheckpoint = UseCase<RecordCheckpointArgs, EnvelopeResult>;

export const RECORD_CHECKPOINT = useCaseToken<RecordCheckpointArgs, EnvelopeResult>(
  "RecordCheckpoint",
);
