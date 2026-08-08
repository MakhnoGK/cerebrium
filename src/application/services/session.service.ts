import { injectable } from "tsyringe";
import { SessionsRepo } from "@/db/repositories";

@injectable()
export class SessionService {
  constructor(private readonly sessionRepo: SessionsRepo) {}

  startSession(id: string, project: string | null, ts: string): void {
    this.sessionRepo.create(id, project, ts);
  }

  requireSession(id: string, ts: string): void {
    if (!this.sessionRepo.touchExisting(id, ts)) {
      throw new Error(
        `Unknown session_id ${id}. Call session_start and copy its returned session_id verbatim.`,
      );
    }
  }
}
