import { inject, injectable } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { SessionsRepo } from "@/db/repositories";
import type { EventDraft } from "@/core/types";

@injectable()
export class EventLogService {
  constructor(
    private readonly sessionsRepo: SessionsRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  public record(drafts: EventDraft[]): void {
    const ts = this.clock.now();

    for (const draft of drafts) {
      try {
        this.sessionsRepo.logEvent(
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
