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
