import { ulid } from "ulid";
import {
  EmbeddingService,
  EventLogService,
  HintsService,
  MemoryService,
  SessionService,
} from "@/application/services";
import {
  RECORD_EVENTS,
  SESSION_HINTS,
  START_SESSION,
  TOUCH_SESSION,
  useCase,
  type RecordEvents,
  type RecordEventsArgs,
  type SessionHints,
  type SessionHintsArgs,
  type SessionHintsResult,
  type StartSession,
  type StartSessionArgs,
  type StartSessionResult,
  type TouchSession,
  type TouchSessionArgs,
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

@useCase(TOUCH_SESSION)
export class LocalTouchSession implements TouchSession {
  constructor(private readonly sessions: SessionService) {}

  invoke(args: TouchSessionArgs): Promise<Record<string, never>> {
    this.sessions.requireSession(args.session_id, new Date().toISOString());

    return Promise.resolve({});
  }
}

@useCase(RECORD_EVENTS)
export class LocalRecordEvents implements RecordEvents {
  constructor(private readonly eventLog: EventLogService) {}

  invoke(args: RecordEventsArgs): Promise<Record<string, never>> {
    this.eventLog.record(args.events);

    return Promise.resolve({});
  }
}
