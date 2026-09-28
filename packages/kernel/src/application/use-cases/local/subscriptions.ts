import { principalOfWriter } from "@/domain/writer";
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
    const principal = args.principal ?? principalOfWriter(this.identity.get());

    return { topics: this.subscriptions.subscribe(principal, args.topics) };
  }
}
