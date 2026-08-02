import { injectable } from "tsyringe";
import { SessionService } from "@/application/services/session.service";

@injectable()
export class HintsService {
  constructor(private readonly sessionsService: SessionService) {}

  // Kept async: the tool boundary awaits it everywhere, and hint sources beyond the
  // session check are expected to be I/O-bound.

  async getUnknownSessionHints(sessionId: string, project: string | null) {
    const now = new Date().toISOString();
    const { created } = this.sessionsService.ensureSession(sessionId, project, now);

    if (created) {
      return [
        `Unknown session_id — created a new session ${sessionId}. Call session_start next time to get one.`,
      ];
    }

    return [];
  }
}
