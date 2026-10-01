import { singleton } from "tsyringe";
import type { ActivityEntry } from "@cerebrium/contracts/dashboard";

type Listener = (entry: ActivityEntry) => void;

// Every audited call, handed to whoever in this process listens as it is recorded. The
// daemon forwards it to subscribed connections; nothing is buffered for a listener that
// was not there.
@singleton()
export class ActivityFeed {
  private readonly listeners = new Set<Listener>();

  listen(listener: Listener): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  publish(entry: ActivityEntry): void {
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // A listener that throws must not fail the call that is being recorded.
      }
    }
  }
}
