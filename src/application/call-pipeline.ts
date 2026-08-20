import { inject, injectable, type DependencyContainer } from "tsyringe";
import { ActivityMonitor } from "@/application/services";
import {
  CALL_SURFACE,
  callAction,
  isAudited,
  isCallName,
  readNameOf,
  RECORD_EVENTS,
  TOUCH_SESSION,
  type CallName,
  type ReadName,
  type RecordEvents,
  type TouchSession,
  type UseCase,
} from "@/application/use-cases";

// Two invariants used to live only in the MCP adapters: a call carrying a session_id
// validates it first, and every call appends an `events` row (invariant #7). A second
// delivery layer resolving use cases directly would silently drop both — session ids would
// stop being checked and the read-loop instrumentation would go blind. So they live here,
// where any caller gets them.
//
// The MCP server still uses its own adapters, which do the same two things. They are
// equivalent, and refactoring a working path twice is worse than leaving it until the
// server becomes a proxy and its adapters disappear altogether.

export type ReadDispatcher = (name: ReadName, args: unknown) => Promise<unknown>;

export class UnknownCallError extends Error {
  constructor(name: string) {
    super(`unknown call: ${name}`);
    this.name = "UnknownCallError";
  }
}

@injectable()
export class CallPipeline {
  // Set to send reads elsewhere (a worker pool). Without it every call runs in-process.
  private reads: ReadDispatcher | undefined;

  constructor(
    @inject(TOUCH_SESSION) private readonly sessions: TouchSession,
    @inject(RECORD_EVENTS) private readonly events: RecordEvents,
    private readonly activity: ActivityMonitor,
  ) {}

  useReadDispatcher(dispatch: ReadDispatcher | undefined): void {
    this.reads = dispatch;
  }

  async invoke(container: DependencyContainer, name: string, args: unknown): Promise<unknown> {
    if (!isCallName(name)) {
      throw new UnknownCallError(name);
    }

    // Marked before the work, not after: a long call must count as activity for its whole
    // duration, not only once it finishes.
    this.activity.note();

    const session = sessionOf(args);

    // Before the call, not after: an unknown session must not be able to write first and
    // be rejected afterwards.
    if (session !== null) {
      await this.sessions.invoke({ session_id: session });
    }

    try {
      const result = await this.run(container, name, args);

      await this.record(name, session, result, null);

      return result;
    } catch (error) {
      await this.record(name, session, null, error as Error);

      throw error;
    }
  }

  private run(container: DependencyContainer, name: CallName, args: unknown): Promise<unknown> {
    const read = readNameOf(name);

    if (read !== null && this.reads !== undefined) {
      return this.reads(read, args);
    }

    return container.resolve<UseCase<unknown, unknown>>(CALL_SURFACE[name].token).invoke(args);
  }

  // `events.session_id` is NOT NULL, so a call that cannot be attributed logs nothing —
  // the same rule the MCP audit adapter follows.
  private async record(
    name: CallName,
    session: string | null,
    result: unknown,
    error: Error | null,
  ): Promise<void> {
    if (session === null || !isAudited(name)) {
      return;
    }

    await this.events.invoke({
      events: [
        {
          action: callAction(name),
          session_id: session,
          ...(error === null ? nodeOf(result) : {}),
          detail: error === null ? null : { error: error.message },
        },
      ],
    });
  }
}

function sessionOf(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;

  const value = (args as { session_id?: unknown }).session_id;

  return typeof value === "string" ? value : null;
}

// Results are not uniformly shaped: `write_memory` answers `{envelope:{id}}` while others
// answer `{id}`. Missing this loses the node attribution the read-loop report joins on.
function nodeOf(result: unknown): { node_id?: string } {
  if (typeof result !== "object" || result === null) return {};

  const direct = (result as { id?: unknown }).id;

  if (typeof direct === "string") return { node_id: direct };

  const envelope = (result as { envelope?: { id?: unknown } }).envelope;
  const nested = envelope?.id;

  return typeof nested === "string" ? { node_id: nested } : {};
}
