import type { Envelope, NeighborStub, NewNode, RevisionMeta } from "@cerebrium/contracts/types";
import type { UseRecorder } from "@/domain/ports/use-recorder";

export const NODES_REPO_TOKEN = Symbol("NodesRepo");

export interface NodesRepo extends UseRecorder {
  exists(id: string): Promise<boolean>;
  referenceState(id: string): Promise<"live" | "invalidated" | "missing">;
  collapseProfile(
    id: string,
  ): Promise<{ type: string; revisions: number; inbound: number } | undefined>;
  nodeOrigin(id: string): Promise<{ memory_kind: string; origin: string | null } | undefined>;
  envelope(id: string): Promise<Envelope | undefined>;
  fullNode(
    id: string,
  ): Promise<{ envelope: Envelope; content: string; edges: NeighborStub[] } | undefined>;
  listRevisions(id: string): Promise<RevisionMeta[]>;
  revisionContent(id: string, rev: number): Promise<string | undefined>;
  createNode(input: NewNode): Promise<Envelope>;
  // Undefined, with nothing written, when a source is no longer a live, unconsolidated
  // episodic node.
  applyDistillation(input: {
    title: string;
    content: string;
    project: string | null;
    sourceIds: string[];
    session_id: string;
    ts: string;
  }): Promise<Envelope | undefined>;
  applyMerge(input: {
    survivorId: string;
    loserId: string;
    session_id: string;
    ts: string;
    merged?: { title: string; body: string };
  }): Promise<Envelope | undefined>;
  applyAnnotation(input: {
    nodeId: string;
    rev: number;
    annotationsJson: string;
    ftsText: string;
    ts: string;
  }): Promise<boolean>;
  addRevision(
    id: string,
    fields: {
      content?: string;
      title?: string;
      session_id: string;
      reason: string | null;
      ts: string;
    },
  ): Promise<Envelope>;
  eventWindow(
    id: string,
  ): Promise<{ event_from: string | null; event_to: string | null } | undefined>;
  setEventWindow(id: string, window: { event_from?: string; event_to?: string }): Promise<void>;
  stateAt(id: string, asOf: string): Promise<{ rev: number; content: string } | undefined>;
  principalsOf(ids: string[]): Promise<Map<string, string>>;
  recordUse(ids: string[], ts: string): Promise<void>;
  invalidateNode(
    id: string,
    fields: { ts: string; superseded_by?: string; session_id: string },
  ): Promise<Envelope>;
  restoreNode(id: string, fields: { ts: string; session_id: string }): Promise<boolean>;
}
