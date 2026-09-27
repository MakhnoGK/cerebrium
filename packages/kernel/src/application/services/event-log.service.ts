import { inject, injectable } from "tsyringe";
import type { EventDraft } from "@cerebrium/contracts/types";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { SESSIONS_REPO_TOKEN, type SessionsRepo } from "@/domain/ports/storage";

@injectable()
export class EventLogService {
  constructor(
    @inject(SESSIONS_REPO_TOKEN) private readonly sessionsRepo: SessionsRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  public async record(drafts: EventDraft[]): Promise<void> {
    const ts = this.clock.now();

    for (const draft of drafts) {
      try {
        await this.sessionsRepo.logEvent(
          draft.action,
          draft.session_id,
          draft.node_id ?? null,
          draft.detail ?? null,
          ts,
        );
      } catch {
        // Best-effort: an unwritable audit row must never fail the call it describes.
      }
    }
  }
}
