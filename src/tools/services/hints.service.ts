import { injectable } from "tsyringe";
import { SessionService } from "@/tools/services/session.service";

@injectable()
export class HintsService {
  constructor(private readonly sessionsService: SessionService) {}

  async getUnknownSessionHints(sessionId: string, project: string | null) {
    const now = new Date().toISOString();
    const { created } = await this.sessionsService.ensureSession(sessionId, project, now);

    if (created) {
      return [
        `Unknown session_id — created a new session ${sessionId}. Call session_start next time to get one.`,
      ];
    }

    return [];
  }
}
