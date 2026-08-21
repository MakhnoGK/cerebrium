import { singleton } from "tsyringe";
import { NotificationTopic } from "@/application/use-cases/contracts/subscriptions";
import { principalIdOf } from "@/core/vocab";

// Who wants to hear what, keyed by principal rather than by connection: a connection is
// dropped by something as ordinary as a daemon restart, and the same principal reconnecting
// is the same subscriber. Lives only in the daemon's memory — a subscription is interest,
// not a promise of delivery, and a subscriber that was away catches up by reading.
@singleton()
export class SubscriptionService {
  private readonly byPrincipal = new Map<string, Set<NotificationTopic>>();

  subscribe(client: string | null, topics: NotificationTopic[]): NotificationTopic[] {
    const principal = principalIdOf(client);

    if (!topics.length) {
      this.byPrincipal.delete(principal);

      return [];
    }

    const wanted = new Set(topics);

    this.byPrincipal.set(principal, wanted);

    return [...wanted];
  }

  wants(client: string | null, topic: NotificationTopic): boolean {
    return this.byPrincipal.get(principalIdOf(client))?.has(topic) === true;
  }

  get subscribers(): number {
    return this.byPrincipal.size;
  }
}
