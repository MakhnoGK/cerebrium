import { useCaseToken, type UseCase } from "@/application/use-cases/contracts/use-case";

// What a subscriber can ask to hear about. Deliberately coarse: a topic names a kind of
// change, not a node — per-node interest would need the subscriber to enumerate what it
// depends on, and nothing does that yet.
export enum NotificationTopic {
  CONSOLIDATION = "consolidation",
}

export interface SubscribeEventsArgs {
  session_id: string;
  topics: NotificationTopic[];
}

export interface SubscribeEventsResult {
  topics: NotificationTopic[];
}

// Records what the calling principal wants to be told about. It is a call on the surface
// rather than a daemon method so the capability posture and the quota apply to it like
// anything else.
export type SubscribeEvents = UseCase<SubscribeEventsArgs, SubscribeEventsResult>;

export const SUBSCRIBE_EVENTS = useCaseToken<SubscribeEventsArgs, SubscribeEventsResult>(
  "SubscribeEvents",
);
