import { injectable } from "tsyringe";
import { SessionsRepo } from "@/db/repositories";

@injectable()
export class SessionService {
  constructor(private readonly sessionRepo: SessionsRepo) {}

  async ensureSession(id: string, project: string | null, ts: string) {
    const existing = await this.sessionRepo.getById(id);

    if (existing) {
      await this.sessionRepo.update({ last_seen: ts }, { id });
      return { created: false };
    }

    await this.sessionRepo.create({ id, project, started_at: ts, last_seen: ts });
    return { created: true };
  }
}
