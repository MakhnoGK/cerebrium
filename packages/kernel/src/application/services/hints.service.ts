import { injectable } from "tsyringe";
import { ReviewService } from "@/application/services/review.service";
import { SessionNotices } from "@/application/services/session-notices.service";
import { SessionService } from "@/application/services/session.service";
import { ConsolidationRepo } from "@/db/repositories/consolidation";
import { chunkContent, sectionName } from "@/core/chunk";
import { RetrievalConfig } from "@/infrastructure/config";

@injectable()
export class HintsService {
  constructor(
    private readonly sessionsService: SessionService,
    private readonly consolidation: ConsolidationRepo,
    private readonly reviews: ReviewService,
    private readonly notices: SessionNotices,
    private readonly retrieval: RetrievalConfig,
  ) {}

  // Kept async: the tool boundary awaits it everywhere, and hint sources beyond the
  // session check are expected to be I/O-bound.

  async getSessionHints(sessionId: string): Promise<string[]> {
    const now = new Date().toISOString();
    this.sessionsService.requireSession(sessionId, now);

    return [...this.backlogHint(sessionId), ...this.reviewHint(sessionId)];
  }

  // Asked for on every tool call, so it is a count rather than a listing, and it stays
  // quiet unless the figure is new to this session.
  private backlogHint(sessionId: string): string[] {
    const pending = this.consolidation.pendingCandidateCount();

    if (pending === 0 || !this.notices.isNews(sessionId, "consolidation", pending)) {
      return [];
    }

    return [
      `${String(pending)} consolidation candidate${pending === 1 ? "" : "s"} awaiting review — ` +
        `consolidate_suggest lists them.`,
    ];
  }

  // What an unattended writer has put in the store on a `suggest` posture. Separate from the
  // consolidation backlog because they are different queues: that one holds proposals, this
  // one holds writes that already landed.
  private reviewHint(sessionId: string): string[] {
    if (this.reviews.reviewsNobody()) return [];

    const { total } = this.reviews.pending();

    if (total === 0 || !this.notices.isNews(sessionId, "reviews", total)) {
      return [];
    }

    return [
      `${String(total)} suggested write${total === 1 ? "" : "s"} awaiting review — ` +
        `review_pending lists them.`,
    ];
  }

  // Advisory only, on the same channel as the duplicate probe. A long body is not a
  // mistake — living index nodes are deliberately long — but it is a cost every reader
  // pays, so the write that creates it is where saying so is cheapest.
  getLongBodyNotes(content: string): string[] {
    const limit = this.retrieval.longBodyChars;

    if (limit === 0 || content.length <= limit) return [];

    const sections = new Set(
      chunkContent("probe", content).map((c) => sectionName(c.heading_path)),
    );
    const size = `${content.length.toLocaleString("en-US")} chars`;

    if (sections.size < 2) {
      return [
        `Long body (${size}) under a single heading, so a reader cannot fetch part of it — ` +
          `add headings to make it addressable, or split it into separate nodes.`,
      ];
    }

    return [
      `Long body (${size}, ${sections.size} sections) — readers can narrow with get's ` +
        `\`sections\`; if it holds several independent facts, prefer separate nodes.`,
    ];
  }
}
