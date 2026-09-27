import { injectable } from "tsyringe";
import { PrincipalsRepo, SessionsRepo } from "@/db/repositories";
import type { Writer } from "@/runtime/client-identity";

@injectable()
export class SessionService {
  constructor(
    private readonly sessionRepo: SessionsRepo,
    private readonly principalRepo: PrincipalsRepo,
  ) {}

  startSession(id: string, project: string | null, ts: string, writer: Writer): string {
    const principal_id = this.principalRepo.resolve(writer, ts);

    this.sessionRepo.create(id, project, ts, writer, principal_id);

    return principal_id;
  }

  requireSession(id: string, ts: string): void {
    if (!this.sessionRepo.touchExisting(id, ts)) {
      throw new Error(
        `Unknown session_id ${id}. Call session_start and copy its returned session_id verbatim.`,
      );
    }
  }
}
