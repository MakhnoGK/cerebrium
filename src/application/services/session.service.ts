import { injectable } from "tsyringe";
import { SessionsRepo } from "@/db/repositories";
import type { Writer } from "@/runtime/client-identity";

@injectable()
export class SessionService {
  constructor(private readonly sessionRepo: SessionsRepo) {}

  startSession(id: string, project: string | null, ts: string, writer: Writer): void {
    this.sessionRepo.create(id, project, ts, writer);
  }

  requireSession(id: string, ts: string): void {
    if (!this.sessionRepo.touchExisting(id, ts)) {
      throw new Error(
        `Unknown session_id ${id}. Call session_start and copy its returned session_id verbatim.`,
      );
    }
  }
}
