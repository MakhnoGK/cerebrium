import { inject, injectable, type DependencyContainer } from "tsyringe";
import { Posture } from "@cerebrium/contracts/vocab";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { USE_RECORDER_TOKEN, type UseRecorder } from "@/domain/ports/use-recorder";
import { principalOfWriter } from "@/domain/writer";
import { auditDetail } from "@/application/audit-detail";
import { CapabilityDeniedError } from "@/application/errors";
import {
  ActivityFeed,
  ActivityMonitor,
  PrincipalPolicyService,
  PrincipalQuotaService,
} from "@/application/services";
import {
  CALL_SURFACE,
  callAction,
  callCapability,
  isAudited,
  isCallName,
  isCodeAware,
  readNameOf,
  RECORD_EVENTS,
  TOUCH_SESSION,
  type CallName,
  type ReadName,
  type RecordEvents,
  type TouchSession,
  type UseCase,
} from "@/application/use-cases";
import { UNKNOWN_WRITER, type Writer } from "@/runtime/client-identity";

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
    @inject(USE_RECORDER_TOKEN) private readonly uses: UseRecorder,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
    private readonly activity: ActivityMonitor,
    private readonly policy: PrincipalPolicyService,
    private readonly quotas: PrincipalQuotaService,
    private readonly feed: ActivityFeed,
  ) {}

  useReadDispatcher(dispatch: ReadDispatcher | undefined): void {
    this.reads = dispatch;
  }

  async invoke(
    container: DependencyContainer,
    name: string,
    args: unknown,
    writer: Writer = UNKNOWN_WRITER,
  ): Promise<unknown> {
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
      await this.sessions.invoke({
        session_id: session,
        ...(writer.principal == null ? {} : { principal: writer.principal }),
      });
    }

    const principal = this.policy.principalOf(writer);

    try {
      const review = this.authorize(name, principal);
      const result = await this.run(container, name, args, writer);

      await this.record(name, session, result, null, review, args, writer);

      return result;
    } catch (error) {
      await this.record(name, session, null, error as Error, false, args, writer);

      throw error;
    }
  }

  // `off` refuses before the call runs. `suggest` lets it through and says so, which is
  // what marks a writer as suspect without dropping what it had to say.
  private authorize(name: CallName, principal: string): boolean {
    const capability = callCapability(name);
    const posture = this.policy.postureFor(principal, capability);

    if (posture === Posture.OFF) {
      throw new CapabilityDeniedError(principal, capability, name);
    }

    this.quotas.consume(
      principal,
      capability,
      this.policy.quotaFor(principal),
      Date.parse(this.clock.now()),
    );

    return posture === Posture.SUGGEST;
  }

  private async run(
    container: DependencyContainer,
    name: CallName,
    args: unknown,
    writer: Writer,
  ): Promise<unknown> {
    const read = readNameOf(name);
    const input = stamped(name, args, writer);

    if (read === null || this.reads === undefined) {
      return await container
        .resolve<UseCase<unknown, unknown>>(CALL_SURFACE[name].token)
        .invoke(input);
    }

    const result = await this.reads(read, input);

    // A pooled read runs on a read-only handle, so the use accounting `get` owes its
    // nodes is settled here instead.
    if (read === "fetch_nodes") {
      await this.uses.recordUse(usedIds(result), this.clock.now());
    }

    return result;
  }

  // `events.session_id` is NOT NULL, so a call that cannot be attributed logs nothing —
  // the same rule the MCP audit adapter follows.
  private async record(
    name: CallName,
    session: string | null,
    result: unknown,
    error: Error | null,
    review: boolean,
    args: unknown,
    writer: Writer,
  ): Promise<void> {
    // `start_session` mints the very session it is attributed to, so its id is in the
    // result rather than the arguments.
    const attributed = session ?? sessionOf(result);

    if (attributed === null || !isAudited(name)) {
      return;
    }

    const node = error === null ? nodeOf(result) : {};
    const detail = detailOf(error, review, error === null ? auditDetail(name, args, result) : null);

    await this.events.invoke({
      events: [{ action: callAction(name), session_id: attributed, ...node, detail }],
    });

    this.feed.publish({
      id: null,
      ts: this.clock.now(),
      action: callAction(name),
      session_id: attributed,
      node_id: node.node_id ?? null,
      principal: this.policy.principalOf(writer),
      client: writer.client ?? null,
      ok: error === null,
      detail,
    });
  }
}

// The writer identity is transport knowledge, not an argument: it is attached here rather
// than accepted from whatever the caller sent, and only the one call that persists it takes
// it at all.
function stamped(name: CallName, args: unknown, writer: Writer): unknown {
  const plain = typeof args === "object" && args !== null ? args : {};

  if (name === "start_session") return { ...plain, client: writer };

  if (name === "subscribe_events") return { ...plain, principal: principalOfWriter(writer) };

  // Only the transport says which branch a caller is on; an argument under that name is
  // dropped.
  if (isCodeAware(name)) {
    const { code_context: _dropped, ...rest } = plain as { code_context?: unknown };

    return writer.code == null ? rest : { ...rest, code_context: writer.code };
  }

  return args;
}

function detailOf(
  error: Error | null,
  review: boolean,
  surfaced: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const detail = {
    ...surfaced,
    ...(error === null ? {} : { error: error.message }),
    ...(review ? { review: true } : {}),
  };

  return Object.keys(detail).length ? detail : null;
}

function usedIds(result: unknown): string[] {
  if (typeof result !== "object" || result === null) return [];

  const used = (result as { used?: unknown }).used;

  return Array.isArray(used) ? used.filter((id): id is string => typeof id === "string") : [];
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
