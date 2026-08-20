import { ulid } from "ulid";
import {
  EmbeddingService,
  HintsService,
  MemoryService,
  SessionService,
} from "@/application/services";
import {
  SESSION_HINTS,
  START_SESSION,
  useCase,
  type SessionHints,
  type SessionHintsArgs,
  type SessionHintsResult,
  type StartSession,
  type StartSessionArgs,
  type StartSessionResult,
} from "@/application/use-cases/contracts";

@useCase(SESSION_HINTS)
export class LocalSessionHints implements SessionHints {
  constructor(private readonly hints: HintsService) {}

  async invoke(args: SessionHintsArgs): Promise<SessionHintsResult> {
    return { hints: await this.hints.getSessionHints(args.session_id) };
  }
}

@useCase(START_SESSION)
export class LocalStartSession implements StartSession {
  constructor(
    private readonly sessions: SessionService,
    private readonly memory: MemoryService,
    private readonly embeddings: EmbeddingService,
  ) {}

  invoke(args: StartSessionArgs): Promise<StartSessionResult> {
    const session_id = ulid();

    this.sessions.startSession(session_id, args.project, new Date().toISOString(), args.client);

    return Promise.resolve({
      session_id,
      project: args.project,
      working_set: this.memory.getWorkingSet(args.project ?? undefined),
      notes: this.embeddings.getEmbeddingNotes(),
    });
  }
}
