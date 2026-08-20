import { connect, type Socket } from "node:net";
import { encodeLine, parseResponseLine, PROTOCOL_VERSION, type RpcResponse } from "@/core/rpc";

export interface RpcClientOptions {
  socketPath: string;
  timeoutMs?: number;
}

export class RpcUnavailableError extends Error {}

const DEFAULT_TIMEOUT_MS = 3_000;

// One request per connection. The daemon holds the state, so there is nothing to keep
// warm on this side, and a short-lived socket cannot leak a half-read stream into the
// next call. Callers that fail over to a local kernel need `RpcUnavailableError` to be
// distinguishable from an error the daemon itself returned.
export async function rpcCall(
  options: RpcClientOptions,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const response = await request(options, { jsonrpc: "2.0", id: 1, method, params });

  if (response.error !== undefined) {
    throw new Error(`${method} failed: ${response.error.message}`);
  }

  return response.result;
}

// Verifies the handshake before anything else runs against the daemon. A resident daemon
// outlives a rebuild, so the client and the daemon are routinely different builds.
export async function rpcHandshake(options: RpcClientOptions): Promise<number> {
  const result = (await rpcCall(options, "initialize")) as { protocol?: unknown };
  const protocol = typeof result.protocol === "number" ? result.protocol : 0;

  if (protocol !== PROTOCOL_VERSION) {
    throw new Error(
      `daemon speaks protocol ${String(protocol)}, this build speaks ${String(PROTOCOL_VERSION)} — ` +
        `restart it with \`cerebrium-service install\``,
    );
  }

  return protocol;
}

function request(
  options: RpcClientOptions,
  payload: { jsonrpc: "2.0"; id: number; method: string; params: Record<string, unknown> },
): Promise<RpcResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let socket: Socket;
    let buffer = "";
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        reject(
          new RpcUnavailableError(
            `no response from ${options.socketPath} in ${String(timeoutMs)}ms`,
          ),
        );
      });
    }, timeoutMs);

    try {
      socket = connect(options.socketPath);
    } catch (err) {
      clearTimeout(timer);
      reject(new RpcUnavailableError((err as Error).message));

      return;
    }

    socket.setEncoding("utf8");

    socket.on("connect", () => {
      socket.write(encodeLine(payload));
    });

    socket.on("data", (chunk: string) => {
      buffer += chunk;

      const newline = buffer.indexOf("\n");

      if (newline < 0) return;

      const parsed = parseResponseLine(buffer.slice(0, newline));

      finish(() => {
        if (parsed === null) {
          reject(new Error("daemon sent a malformed response"));

          return;
        }

        resolve(parsed);
      });
    });

    socket.on("error", (err) => {
      finish(() => {
        reject(new RpcUnavailableError(err.message));
      });
    });

    socket.on("close", () => {
      finish(() => {
        reject(new RpcUnavailableError("daemon closed the connection without replying"));
      });
    });
  });
}
