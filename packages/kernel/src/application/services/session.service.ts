import { inject, injectable } from "tsyringe";
import {
  PRINCIPALS_REPO_TOKEN,
  SESSIONS_REPO_TOKEN,
  type PrincipalsRepo,
  type SessionsRepo,
} from "@/domain/ports/storage";
import type { Writer } from "@/runtime/client-identity";

@injectable()
export class SessionService {
  constructor(
    @inject(SESSIONS_REPO_TOKEN) private readonly sessionRepo: SessionsRepo,
    @inject(PRINCIPALS_REPO_TOKEN) private readonly principalRepo: PrincipalsRepo,
  ) {}

  async startSession(
    id: string,
    project: string | null,
    ts: string,
    writer: Writer,
  ): Promise<string> {
    const principal_id = await this.principalRepo.resolve(writer, ts);

    await this.sessionRepo.create(id, project, ts, writer, principal_id);

    return principal_id;
  }

  async requireSession(id: string, ts: string, principal?: string): Promise<void> {
    if (!(await this.sessionRepo.touchExisting(id, ts))) {
      throw new Error(
        `Unknown session_id ${id}. Call session_start and copy its returned session_id verbatim.`,
      );
    }

    if (principal !== undefined && (await this.sessionRepo.principalOf(id)) !== principal) {
      throw new Error(
        `session_id ${id} belongs to another principal. Call session_start for a session of your own.`,
      );
    }
  }
}
