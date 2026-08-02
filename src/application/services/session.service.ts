import { injectable } from "tsyringe";
import { SessionsRepo } from "@/db/repositories";

@injectable()
export class SessionService {
  constructor(private readonly sessionRepo: SessionsRepo) {}

  ensureSession(id: string, project: string | null, ts: string): { created: boolean } {
    return this.sessionRepo.touch(id, project, ts);
  }
}
