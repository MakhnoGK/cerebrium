import { connect, type Socket } from "node:net";
import {
  encodeLine,
  parseInbound,
  PROTOCOL_VERSION,
  RPC_DEADLINE_MS,
  RpcWork,
  type RpcMeta,
  type RpcResponse,
} from "@/core/rpc";

export interface RpcClientOptions {
  socketPath: string;
  // How long to wait for the answer. A caller that knows the method should pass the
  // deadline for that method's work — see `callDeadlineMs`.
  timeoutMs?: number;
  // Whether THIS call may be sent again if the connection dies before it is answered.
  // A held-open connection can be dropped under a caller by something as ordinary as a
  // daemon restart, and resending is the difference between a read that rides it out and
  // a write that gets applied twice. Describes the call, not the client.
  retryable?: boolean;
}

export class RpcUnavailableError extends Error {
  constructor(
    message: string,
    // The connection failed, as opposed to the daemon being slow. Only the first is safe
    // to resend, and only for a call that says it is.
    readonly connectionLost = false,
  ) {
    super(message);
  }
}

export type NotificationHandler = (method: string, params: Record<string, unknown>) => void;

const DEFAULT_TIMEOUT_MS = RPC_DEADLINE_MS[RpcWork.INTERACTIVE];

interface Pending {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// One connection per socket path, held open and shared by every call to that daemon.
//
// It used to be one connection per request, which was the simpler correct thing while the
// traffic was strictly request/response: a short-lived socket cannot leak a half-read
// stream into the next call, and the connect itself measured 0.28ms, so nothing was being
// paid for it. What it could not do is receive anything the daemon was not asked for —
// there was no connection open for a push to arrive on. Holding it open is what makes the
// daemon able to speak first.
class Connection {
  private socket: Socket | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly socketPath: string,
    private readonly handlers: Set<NotificationHandler>,
  ) {}

  async send(
    method: string,
    params: Record<string, unknown>,
    meta: RpcMeta | undefined,
    timeoutMs: number,
    retryable: boolean,
  ): Promise<RpcResponse> {
    try {
      return await this.attempt(method, params, meta, timeoutMs);
    } catch (err) {
      if (!retryable || !(err instanceof RpcUnavailableError) || !err.connectionLost) {
        throw err;
      }

      // Exactly one more attempt, on a connection built from scratch. A second failure is
      // the daemon being gone rather than a connection that had gone stale under us.
      this.close();

      return await this.attempt(method, params, meta, timeoutMs);
    }
  }

  private attempt(
    method: string,
    params: Record<string, unknown>,
    meta: RpcMeta | undefined,
    timeoutMs: number,
  ): Promise<RpcResponse> {
    // Whether the socket was usable is decided BEFORE anything is written, and that is the
    // only case a reconnect is allowed to cover: a request whose bytes went out is never
    // sent twice, because a write is not idempotent and the daemon may have run it.
    const socket = this.live() ?? this.open();
    const id = this.nextId++;

    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        // The connection survives its own timeouts: another call may be in flight on it,
        // and a late answer to this one is dropped as an id nobody is waiting for.
        this.pending.delete(id);
        reject(
          new RpcUnavailableError(`no response from ${this.socketPath} in ${String(timeoutMs)}ms`),
        );
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      try {
        socket.write(
          encodeLine({
            jsonrpc: "2.0",
            id,
            method,
            params,
            ...(meta === undefined ? {} : { meta }),
          }),
        );
      } catch (err) {
        this.settle(id, () => {
          reject(new RpcUnavailableError((err as Error).message, true));
        });
      }
    });
  }

  close(): void {
    this.fail(new RpcUnavailableError("connection closed", true));
    this.socket?.destroy();
    this.socket = null;
  }

  private live(): Socket | null {
    const socket = this.socket;

    return socket !== null && socket.writable && !socket.destroyed ? socket : null;
  }

  private open(): Socket {
    const socket = connect(this.socketPath);

    // Never a reason for a process to stay alive: a host is kept up by its stdio and the
    // daemon by its listener, so an idle connection here must not hold either one open.
    socket.unref();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.receive(chunk);
    });
    socket.on("error", (err) => {
      this.drop(socket, new RpcUnavailableError(err.message, true));
    });
    socket.on("close", () => {
      this.drop(socket, new RpcUnavailableError("daemon closed the connection", true));
    });

    this.socket = socket;
    this.buffer = "";

    return socket;
  }

  private receive(chunk: string): void {
    this.buffer += chunk;

    let newline = this.buffer.indexOf("\n");

    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);

      if (line.trim().length) this.dispatch(line);

      newline = this.buffer.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    const inbound = parseInbound(line);

    if (inbound === null) {
      this.fail(new Error("daemon sent a malformed response"));

      return;
    }

    if (inbound.kind === "notification") {
      for (const handler of this.handlers) handler(inbound.method, inbound.params);

      return;
    }

    const id = inbound.response.id;

    if (typeof id !== "number") return;

    this.settle(id, (entry) => {
      entry.resolve(inbound.response);
    });
  }

  private settle(id: number, act: (entry: Pending) => void): void {
    const entry = this.pending.get(id);

    if (entry === undefined) return;

    clearTimeout(entry.timer);
    this.pending.delete(id);
    act(entry);
  }

  private drop(socket: Socket, error: Error): void {
    if (this.socket === socket) this.socket = null;

    this.fail(error);
  }

  private fail(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(error);
    }
  }
}

const connections = new Map<string, Connection>();
const handlers = new Map<string, Set<NotificationHandler>>();

function connectionFor(socketPath: string): Connection {
  const existing = connections.get(socketPath);

  if (existing) return existing;

  const listeners = handlers.get(socketPath) ?? new Set<NotificationHandler>();
  handlers.set(socketPath, listeners);

  const created = new Connection(socketPath, listeners);
  connections.set(socketPath, created);

  return created;
}

// Callers that fail over to a local kernel need `RpcUnavailableError` to be distinguishable
// from an error the daemon itself returned.
export async function rpcCall(
  options: RpcClientOptions,
  method: string,
  params: Record<string, unknown> = {},
  meta?: RpcMeta,
): Promise<unknown> {
  const response = await connectionFor(options.socketPath).send(
    method,
    params,
    meta,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.retryable ?? false,
  );

  if (response.error !== undefined) {
    throw new Error(`${method} failed: ${response.error.message}`);
  }

  return response.result;
}

// Registers interest in whatever the daemon pushes on this connection. Returns the
// unsubscribe. What may be pushed, and who asked for it, is not decided here — this is the
// channel, not the subscription.
export function onRpcNotification(socketPath: string, handler: NotificationHandler): () => void {
  connectionFor(socketPath);

  const listeners = handlers.get(socketPath)!;
  listeners.add(handler);

  return () => listeners.delete(handler);
}

// Drops every held connection. A host exits by exiting, so this is for tests and for a
// deliberate teardown rather than for normal operation.
export function closeRpcConnections(): void {
  for (const connection of connections.values()) connection.close();

  connections.clear();
}

// Verifies the handshake before anything else runs against the daemon. A resident daemon
// outlives a rebuild, so the client and the daemon are routinely different builds.
export async function rpcHandshake(options: RpcClientOptions): Promise<number> {
  const result = (await rpcCall({ ...options, retryable: true }, "initialize")) as {
    protocol?: unknown;
  };
  const protocol = typeof result.protocol === "number" ? result.protocol : 0;

  if (protocol !== PROTOCOL_VERSION) {
    throw new Error(
      `daemon speaks protocol ${String(protocol)}, this build speaks ${String(PROTOCOL_VERSION)} — ` +
        `restart it with \`cerebrium-service install\``,
    );
  }

  return protocol;
}
