import { Inject, Injectable } from "@nestjs/common";
import type {
  CandidateDecisionBody,
  CandidateDecisionResult,
  CandidatePage,
  NodePreview,
  ReviewDecisionBody,
  ReviewDecisionResult,
  ReviewPage,
} from "@cerebrium/contracts/dashboard";
import type { ConsolidationCandidate } from "@cerebrium/contracts/types";
import type {
  WikilinkDangler,
  WikilinkFix,
  WikilinkFixResult,
} from "@cerebrium/contracts/wikilinks";
import { KernelClient } from "./kernel.client";

const PAGE = 20;

interface FetchedNode {
  id: string;
  kind?: string;
  type?: string;
  title?: string;
  project?: string | null;
  content?: string;
  source?: string;
  invalidated?: boolean;
}

function preview(id: string, node: FetchedNode | undefined): NodePreview {
  if (!node) {
    return {
      id,
      found: false,
      title: null,
      type: null,
      memory_kind: null,
      project: null,
      content: null,
      invalidated: false,
    };
  }

  return {
    id,
    found: true,
    title: node.title ?? null,
    type: node.type ?? null,
    memory_kind: node.kind ?? null,
    project: node.project ?? null,
    content: node.content ?? node.source ?? null,
    invalidated: node.invalidated === true,
  };
}

@Injectable()
export class ReviewService {
  constructor(@Inject(KernelClient) private readonly kernel: KernelClient) {}

  async candidates(kind?: string, cursor?: string): Promise<CandidatePage> {
    const page = await this.kernel.call<{
      candidates: ConsolidationCandidate[];
      next_cursor?: string;
    }>("suggest_candidates", {
      page_size: PAGE,
      ...(kind ? { kind } : {}),
      ...(cursor ? { cursor } : {}),
    });
    const ids = [...new Set(page.candidates.flatMap((c) => c.member_ids))];
    const nodes = ids.length
      ? (await this.kernel.call<{ nodes: FetchedNode[] }>("fetch_nodes", { ids })).nodes
      : [];
    const byId = new Map(nodes.map((n) => [n.id, n]));

    return {
      candidates: page.candidates.map((candidate) => ({
        candidate,
        members: candidate.member_ids.map((id) => preview(id, byId.get(id))),
      })),
      next_cursor: page.next_cursor ?? null,
    };
  }

  async decide(id: string, body: CandidateDecisionBody): Promise<CandidateDecisionResult> {
    return this.kernel.call<CandidateDecisionResult>(
      "apply_candidate",
      {
        session_id: await this.kernel.sessionId(),
        id,
        decision: body.decision,
        ...(body.override ? { override: body.override } : {}),
        ...(body.collapse === true ? { collapse: true } : {}),
      },
      60_000,
    );
  }

  async retry(id: string): Promise<{ status: string }> {
    return this.kernel.call<{ status: string }>("retry_candidate", {
      session_id: await this.kernel.sessionId(),
      id,
    });
  }

  danglers(): Promise<WikilinkDangler[]> {
    return this.kernel.call<WikilinkDangler[]>("list_danglers", {});
  }

  async fixLink(body: WikilinkFix): Promise<WikilinkFixResult> {
    return this.kernel.call<WikilinkFixResult>("fix_wikilink", {
      session_id: await this.kernel.sessionId(),
      node_id: body.node_id,
      link: body.link,
      action: body.action,
      ...(body.target_id ? { target_id: body.target_id } : {}),
    });
  }

  reviews(): Promise<ReviewPage> {
    return this.kernel.call<ReviewPage>("list_reviews", { limit: 100 });
  }

  async resolve(body: ReviewDecisionBody): Promise<ReviewDecisionResult> {
    return this.kernel.call<ReviewDecisionResult>("resolve_review", {
      session_id: await this.kernel.sessionId(),
      artifact: body.artifact,
      ref: body.ref,
      decision: body.decision,
      ...(body.note ? { note: body.note } : {}),
    });
  }
}
