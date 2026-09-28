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
  type RpcRequest,
} from "@cerebrium/contracts/rpc";
import { InvalidArgsError } from "@/presentation/rpc/schemas";

export type RpcMethod = (params: Record<string, unknown>, meta: RpcMeta) => Promise<unknown>;

// A single request line is bounded so a stuck or hostile writer cannot grow the buffer
// without limit; the daemon has to stay answerable.
const MAX_LINE_BYTES = 1_000_000;

// A connection on the network listener is anonymous until its first frame,
// `initialize {token}`, names a live token. From then on the token's principal is the
// caller, whatever `meta.client` says.
export interface NetworkAuth {
  authenticate(token: string): Promise<{ principal: string } | null>;
  methods: ReadonlySet<string>;
}

const HANDSHAKE_TIMEOUT_MS = 10_000;
const KEEPALIVE_MS = 30_000;

interface NetworkState {
  auth: NetworkAuth;
  token: string | null;
  principal: string | null;
  pending: Promise<boolean> | null;
  refused: boolean;
}

interface ConnectionState {
  client: string | null;
  network: NetworkState | null;
}

export interface RpcServerOptions {
  // Consulted when the socket file already exists: true means another daemon owns it and
  // binding must fail rather than steal the address. A crash leaves the file behind with
  // nobody listening, and that one must be removed or bind() returns EADDRINUSE forever.
  isOwnedByLiveDaemon?: () => boolean;
  onError?: (message: string) => void;
}

export class RpcServer {
  private server: Server | null = null;
  private network: Server | null = null;
  // The identity a connection last called with, so a notification can be routed by
  // principal. On the unix socket it is recorded from `meta` on any request; on the
  // network listener it is the token's principal.
  private readonly sockets = new Map<Socket, ConnectionState>();

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
      this.accept(socket, null);
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

  // Resolves with the bound address, so a caller that asked for port 0 learns the port.
  listenTcp(
    host: string,
    port: number,
    auth: NetworkAuth,
  ): Promise<{ host: string; port: number }> {
    const server = createServer((socket) => {
      this.accept(socket, auth);
    });

    this.network = server;

    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);

        const bound = server.address();

        resolve(
          typeof bound === "object" && bound !== null
            ? { host: bound.address, port: bound.port }
            : { host, port },
        );
      });
    });
  }

  async close(): Promise<void> {
    for (const socket of this.sockets.keys()) socket.destroy();
    this.sockets.clear();

    const servers = [this.server, this.network].filter((s): s is Server => s !== null);

    this.server = null;
    this.network = null;

    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => {
              resolve();
            });
          }),
      ),
    );
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

  private accept(socket: Socket, auth: NetworkAuth | null): void {
    this.sockets.set(socket, {
      client: null,
      network:
        auth === null
          ? null
          : { auth, token: null, principal: null, pending: null, refused: false },
    });
    socket.setEncoding("utf8");

    if (auth !== null) {
      socket.setKeepAlive(true, KEEPALIVE_MS);
      socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => {
        socket.destroy();
      });
    }

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
    const id = request.id ?? null;
    let meta: RpcMeta = request.meta ?? {};

    if (identity?.network != null) {
      const principal = await this.admit(socket, identity.network, request);

      if (principal === null) return;

      identity.client = principal;
      meta = { ...meta, principal };

      if (!identity.network.auth.methods.has(request.method)) {
        if (!isNotification(request)) {
          this.reply(
            socket,
            errorResponse(id, RPC_ERROR.methodNotFound, `${request.method} is not served over tcp`),
          );
        }

        return;
      }
    } else if (identity && typeof request.meta?.client === "string") {
      identity.client = request.meta.client;
    }

    const method = this.methods[request.method];

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
      const result = await method(request.params ?? {}, meta);

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

  // The principal this request runs as, or null once the connection has been refused.
  // Frames that arrive while the handshake is in flight wait for its verdict.
  private async admit(
    socket: Socket,
    state: NetworkState,
    request: RpcRequest,
  ): Promise<string | null> {
    if (state.refused) return null;

    if (state.principal === null && state.pending === null) {
      const token = request.method === "initialize" ? request.params?.token : undefined;

      if (typeof token !== "string" || !token.length) {
        this.refuse(socket, state, request, "the first frame must be initialize {token}");

        return null;
      }

      state.pending = this.verify(state, token);
    }

    if (state.principal === null) {
      if (!(await state.pending)) {
        this.refuse(socket, state, request, "invalid or revoked token");

        return null;
      }

      socket.setTimeout(0);

      return state.principal;
    }

    if (!(await this.verify(state, state.token!))) {
      this.refuse(socket, state, request, "the token was revoked");

      return null;
    }

    return state.principal;
  }

  private async verify(state: NetworkState, token: string): Promise<boolean> {
    let found: { principal: string } | null;

    try {
      found = await state.auth.authenticate(token);
    } catch (err) {
      this.options.onError?.(`tcp auth: ${(err as Error).message}`);
      found = null;
    }

    if (found === null) return false;

    state.token = token;
    state.principal = found.principal;

    return true;
  }

  private refuse(socket: Socket, state: NetworkState, request: RpcRequest, why: string): void {
    if (state.refused) return;

    state.refused = true;
    state.principal = null;
    socket.end(encodeLine(errorResponse(request.id ?? null, RPC_ERROR.unauthorized, why)));
  }

  private reply(socket: Socket, response: ReturnType<typeof successResponse>): void {
    if (socket.writable) socket.write(encodeLine(response));
  }
}

function issuesOf(err: unknown): { issues: string[] } | undefined {
  return err instanceof InvalidArgsError ? { issues: err.issues } : undefined;
}
