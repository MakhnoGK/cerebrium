import { SubscriptionService } from "@/application/services/subscription.service";
import {
  SUBSCRIBE_EVENTS,
  useCase,
  type SubscribeEvents,
  type SubscribeEventsArgs,
  type SubscribeEventsResult,
} from "@/application/use-cases/contracts";
import { ClientIdentity } from "@/runtime/client-identity";

@useCase(SUBSCRIBE_EVENTS)
export class LocalSubscribeEvents implements SubscribeEvents {
  constructor(
    private readonly subscriptions: SubscriptionService,
    private readonly identity: ClientIdentity,
  ) {}

  async invoke(args: SubscribeEventsArgs): Promise<SubscribeEventsResult> {
    return { topics: this.subscriptions.subscribe(this.identity.get().client, args.topics) };
  }
}
