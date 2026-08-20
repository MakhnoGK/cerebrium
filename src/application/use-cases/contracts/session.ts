import { useCaseToken, type UseCase } from "@/application/use-cases/contracts/use-case";
import type { Writer } from "@/runtime/client-identity";

export interface SessionHintsArgs {
  session_id: string;
}

export interface SessionHintsResult {
  hints: string[];
}

// Every tool asks for these before doing anything, which is also what validates the
// session id. It reaches the session store, so it is a kernel call like any other.
export type SessionHints = UseCase<SessionHintsArgs, SessionHintsResult>;

export const SESSION_HINTS = useCaseToken<SessionHintsArgs, SessionHintsResult>("SessionHints");

export interface StartSessionArgs {
  project: string | null;
  // The host knows which client it is serving; the kernel only records it.
  client: Writer;
}

export interface StartSessionResult {
  session_id: string;
  project: string | null;
  working_set: Record<string, unknown>;
  notes: string[];
}

export type StartSession = UseCase<StartSessionArgs, StartSessionResult>;

export const START_SESSION = useCaseToken<StartSessionArgs, StartSessionResult>("StartSession");
