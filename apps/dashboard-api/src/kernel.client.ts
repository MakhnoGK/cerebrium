import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Subject } from "rxjs";
import type { ActivityEntry, SweptNotice } from "@cerebrium/contracts/dashboard";
import type { RpcMeta } from "@cerebrium/contracts/rpc";
import { onRpcNotification, rpcCall } from "@cerebrium/kernel/runtime/rpc-client";

const META: RpcMeta = { client: "cerebrium-dashboard", version: "1" };
const RESUBSCRIBE_MS = 60_000;

export type KernelNotice =
  { type: "activity"; data: ActivityEntry } | { type: "consolidation"; data: SweptNotice };

// The dashboard's one connection to the daemon: the unix socket in the shared data volume
// on the host, or a host's TCP listener with a token. Subscriptions live only in the daemon's memory, so they are renewed on a timer and
// survive a daemon restart without anyone noticing.
@Injectable()
export class KernelClient implements OnModuleDestroy {
  readonly notices = new Subject<KernelNotice>();
  private session: string | null = null;
  private readonly timer: NodeJS.Timeout;
  private readonly unlisten: () => void;

  constructor(
    private readonly socketPath: string,
    private readonly token: string | null = null,
  ) {
    this.unlisten = onRpcNotification(socketPath, (method, params) => {
      if (method === "activity.recorded") {
        this.notices.next({ type: "activity", data: params as unknown as ActivityEntry });
      } else if (method === "consolidation.swept") {
        this.notices.next({ type: "consolidation", data: params as unknown as SweptNotice });
      }
    });
    this.timer = setInterval(() => void this.subscribe(), RESUBSCRIBE_MS);
    this.timer.unref();
    void this.subscribe();
  }

  call<T>(name: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    return rpcCall(
      { socketPath: this.socketPath, token: this.token, timeoutMs },
      name,
      args,
      META,
    ) as Promise<T>;
  }

  async subscribe(): Promise<boolean> {
    try {
      this.session ??= (await this.call<{ session_id: string }>("start_session", {})).session_id;
      await this.call("subscribe_events", {
        session_id: this.session,
        topics: ["activity", "consolidation"],
      });

      return true;
    } catch {
      this.session = null;

      return false;
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    this.unlisten();
    this.notices.complete();
  }
}
