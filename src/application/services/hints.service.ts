import { injectable } from "tsyringe";
import { SessionService } from "@/application/services/session.service";
import { chunkContent, sectionName } from "@/core/chunk";
import { RetrievalConfig } from "@/infrastructure/config";

@injectable()
export class HintsService {
  constructor(
    private readonly sessionsService: SessionService,
    private readonly retrieval: RetrievalConfig,
  ) {}

  // Kept async: the tool boundary awaits it everywhere, and hint sources beyond the
  // session check are expected to be I/O-bound.

  async getSessionHints(sessionId: string): Promise<string[]> {
    const now = new Date().toISOString();
    this.sessionsService.requireSession(sessionId, now);

    return [];
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
