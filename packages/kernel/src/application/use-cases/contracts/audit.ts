import type { EventDraft } from "@cerebrium/contracts/types";
import { useCaseToken, type UseCase } from "@/application/use-cases/contracts/use-case";

export interface RecordEventsArgs {
  events: EventDraft[];
}

// Invariant #7: every tool call appends an `events` row.
export type RecordEvents = UseCase<RecordEventsArgs, Record<string, never>>;

export const RECORD_EVENTS = useCaseToken<RecordEventsArgs, Record<string, never>>("RecordEvents");
