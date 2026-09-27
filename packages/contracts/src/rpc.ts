// Local socket protocol, shared by both ends — the daemon that serves it and the hosts
// that call it — which is why it sits in core rather than beside either one.
//
// Newline-delimited JSON framing carrying JSON-RPC 2.0. The
// framing matches MCP stdio exactly, so a proxy re-frames rather than re-encodes, and
// the envelope is the one MCP already speaks, which is where request correlation and
// server->client notifications come from for free.

// Bumped only on a breaking change to the envelope or to a method's shape. A resident
// daemon outlives a rebuild, so a new client talking to an old daemon is the normal
// case, not an edge one — the mismatch has to name itself rather than surface as an
// unknown method.
export const PROTOCOL_VERSION = 2;

// macOS caps sockaddr_un.sun_path at 104 bytes including the terminator, and bind()
// fails with a message that does not mention the length.
export const SUN_PATH_MAX = 103;

// What a client waits for an answer, by the shape of the work the call does. Interactive
// covers in-memory work plus at most one embedding model load (measured 4.6-5.7s);
// generative covers a write whose inline reconcile reaches the generation provider;
// indexing covers a repo parse and re-embed.
export enum RpcWork {
  INTERACTIVE = "interactive",
  GENERATIVE = "generative",
  INDEXING = "indexing",
}

export const RPC_DEADLINE_MS: Record<RpcWork, number> = {
  [RpcWork.INTERACTIVE]: 15_000,
  [RpcWork.GENERATIVE]: 45_000,
  [RpcWork.INDEXING]: 600_000,
};

export const RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

// Who is calling, carried beside `params` rather than inside them. The distinction is the
// whole point: `params` is what the caller asked for and a tool schema validates it, while
// `meta` is what the transport knows about the caller. A model driving a tool can put
// anything in `params`; it cannot reach this.
export interface RpcMeta {
  client?: string | null;
  version?: string | null;
}

export interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
  meta?: RpcMeta;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: RpcError;
}

export function successResponse(id: string | number | null, result: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export function encodeLine(message: RpcResponse | RpcRequest): string {
  return `${JSON.stringify(message)}\n`;
}

export type ParsedRequest =
  | { ok: true; request: RpcRequest }
  | { ok: false; id: string | number | null; code: number; message: string };

export function parseRequest(line: string): ParsedRequest {
  let raw: unknown;

  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, id: null, code: RPC_ERROR.parse, message: "malformed JSON" };
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      id: null,
      code: RPC_ERROR.invalidRequest,
      message: "not a JSON-RPC object",
    };
  }

  const candidate = raw as Partial<RpcRequest>;
  const id = candidate.id ?? null;

  if (candidate.jsonrpc !== "2.0") {
    return { ok: false, id, code: RPC_ERROR.invalidRequest, message: 'jsonrpc must be "2.0"' };
  }

  if (typeof candidate.method !== "string" || !candidate.method.length) {
    return { ok: false, id, code: RPC_ERROR.invalidRequest, message: "method must be a string" };
  }

  return {
    ok: true,
    request: {
      jsonrpc: "2.0",
      id,
      method: candidate.method,
      params: candidate.params,
      meta: parseMeta(candidate.meta),
    },
  };
}

// Anything that is not a string becomes null rather than travelling on as a claim: this
// value ends up attributed to writes, so a malformed one must not read as an identity.
function parseMeta(raw: unknown): RpcMeta {
  if (typeof raw !== "object" || raw === null) return {};

  const { client, version } = raw as RpcMeta;

  return {
    client: typeof client === "string" ? client : null,
    version: typeof version === "string" ? version : null,
  };
}

export function socketPathProblem(socketPath: string): string | null {
  const bytes = Buffer.byteLength(socketPath, "utf8");

  return bytes > SUN_PATH_MAX
    ? `socket path is ${String(bytes)} bytes, over the ${String(SUN_PATH_MAX)}-byte platform limit: ` +
        `${socketPath}. Set CEREBRIUM_HOME to a shorter path.`
    : null;
}

// A request is a notification when it carries no id; JSON-RPC forbids replying to one.
export function isNotification(request: RpcRequest): boolean {
  return request.id === null || request.id === undefined;
}

export function parseResponseLine(line: string): RpcResponse | null {
  try {
    const raw = JSON.parse(line) as Partial<RpcResponse>;

    return raw.jsonrpc === "2.0" ? (raw as RpcResponse) : null;
  } catch {
    return null;
  }
}

// A server -> client message. It carries a method like a request but no id, so the
// receiver must not reply to it. This is the direction the envelope always allowed and
// nothing used: one request per connection left nowhere to push to.
export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

export function notificationFrame(
  method: string,
  params: Record<string, unknown> = {},
): RpcNotification {
  return { jsonrpc: "2.0", method, params };
}

export type Inbound =
  | { kind: "response"; response: RpcResponse }
  | { kind: "notification"; method: string; params: Record<string, unknown> };

// One parse for both shapes a client can receive on a connection it is holding open. A
// line with a method is a push; a line with an id is the answer to something it asked.
export function parseInbound(line: string): Inbound | null {
  let raw: unknown;

  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;

  const message = raw as Partial<RpcResponse & RpcNotification>;

  if (message.jsonrpc !== "2.0") return null;

  if (typeof message.method === "string") {
    return { kind: "notification", method: message.method, params: message.params ?? {} };
  }

  return message.id === undefined ? null : { kind: "response", response: message as RpcResponse };
}
