import { chmodSync, existsSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import {
  encodeLine,
  errorResponse,
  isNotification,
  notificationFrame,
  parseRequest,
  RPC_ERROR,
  socketPathProblem,
  successResponse,
  type RpcMeta,
} from "@/core/rpc";
import { InvalidArgsError } from "@/presentation/rpc/schemas";

export type RpcMethod = (params: Record<string, unknown>, meta: RpcMeta) => Promise<unknown>;

// A single request line is bounded so a stuck or hostile writer cannot grow the buffer
// without limit; the daemon has to stay answerable.
const MAX_LINE_BYTES = 1_000_000;

export interface RpcServerOptions {
  // Consulted when the socket file already exists: true means another daemon owns it and
  // binding must fail rather than steal the address. A crash leaves the file behind with
  // nobody listening, and that one must be removed or bind() returns EADDRINUSE forever.
  isOwnedByLiveDaemon?: () => boolean;
  onError?: (message: string) => void;
}

export class RpcServer {
  private server: Server | null = null;
  // The identity a connection last called with, so a notification can be routed by
  // principal. Recorded from `meta` on any request rather than at the handshake, which
  // carries no identity of its own.
  private readonly sockets = new Map<Socket, { client: string | null }>();

  constructor(
    private readonly methods: Record<string, RpcMethod>,
    private readonly options: RpcServerOptions = {},
  ) {}

  listen(socketPath: string): Promise<void> {
    const problem = socketPathProblem(socketPath);

    if (problem !== null) {
      return Promise.reject(new Error(problem));
    }

    if (existsSync(socketPath)) {
      if (this.options.isOwnedByLiveDaemon?.() === true) {
        return Promise.reject(new Error(`another daemon is listening on ${socketPath}`));
      }

      rmSync(socketPath, { force: true });
    }

    const server = createServer((socket) => {
      this.accept(socket);
    });

    this.server = server;

    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        // Owner-only permissions are the whole auth model on a single-user desktop.
        chmodSync(socketPath, 0o600);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const socket of this.sockets.keys()) socket.destroy();
    this.sockets.clear();

    const server = this.server;

    if (server === null) return;

    this.server = null;

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  // Speaks to every connection the daemon is holding, without being asked. Deliberately
  // undirected: which client should hear what is a routing question, and routing needs
  // subscriptions, which do not exist yet. This is the channel they will be carried on.
  broadcast(method: string, params: Record<string, unknown> = {}): number {
    return this.notify(method, params, () => true);
  }

  // The directed form: only connections whose principal wants this topic hear it. `wants`
  // is supplied by the caller, so routing policy stays out of the transport.
  notify(
    method: string,
    params: Record<string, unknown>,
    wants: (client: string | null) => boolean,
  ): number {
    const line = encodeLine(notificationFrame(method, params));
    let reached = 0;

    for (const [socket, identity] of this.sockets) {
      if (!socket.writable || !wants(identity.client)) continue;

      socket.write(line);
      reached++;
    }

    return reached;
  }

  private accept(socket: Socket): void {
    this.sockets.set(socket, { client: null });
    socket.setEncoding("utf8");

    let buffer = "";

    socket.on("data", (chunk: string) => {
      buffer += chunk;

      if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) {
        socket.write(encodeLine(errorResponse(null, RPC_ERROR.parse, "request too large")));
        socket.destroy();

        return;
      }

      let newline = buffer.indexOf("\n");

      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);

        if (line.length) void this.handleLine(socket, line);

        newline = buffer.indexOf("\n");
      }
    });

    socket.on("error", (err) => {
      this.options.onError?.(err.message);
    });

    socket.on("close", () => {
      this.sockets.delete(socket);
    });
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    const parsed = parseRequest(line);

    if (!parsed.ok) {
      this.reply(socket, errorResponse(parsed.id, parsed.code, parsed.message));

      return;
    }

    const { request } = parsed;
    const identity = this.sockets.get(socket);

    if (identity && typeof request.meta?.client === "string") {
      identity.client = request.meta.client;
    }

    const method = this.methods[request.method];
    const id = request.id ?? null;

    if (method === undefined) {
      if (!isNotification(request)) {
        this.reply(
          socket,
          errorResponse(id, RPC_ERROR.methodNotFound, `unknown method: ${request.method}`, {
            known: Object.keys(this.methods),
          }),
        );
      }

      return;
    }

    try {
      const result = await method(request.params ?? {}, request.meta ?? {});

      if (!isNotification(request)) this.reply(socket, successResponse(id, result));
    } catch (err) {
      const message = (err as Error).message || String(err);
      // A caller that sent the wrong arguments should be told so, not handed an internal
      // error it cannot act on.
      const code = err instanceof InvalidArgsError ? RPC_ERROR.invalidParams : RPC_ERROR.internal;

      this.options.onError?.(`${request.method}: ${message}`);

      if (!isNotification(request)) {
        this.reply(socket, errorResponse(id, code, message, issuesOf(err)));
      }
    }
  }

  private reply(socket: Socket, response: ReturnType<typeof successResponse>): void {
    if (socket.writable) socket.write(encodeLine(response));
  }
}

function issuesOf(err: unknown): { issues: string[] } | undefined {
  return err instanceof InvalidArgsError ? { issues: err.issues } : undefined;
}
