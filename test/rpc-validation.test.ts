import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { rpcCall } from "@/runtime/rpc-client";
import { RPC_ERROR } from "@/core/rpc";
import { MemoryKind } from "@/core/vocab";
import {
  InvalidArgsError,
  RpcServer,
  schemaNames,
  surfaceMethods,
  surfaceNames,
  validateCall,
} from "@/presentation/rpc";

const SOCKET = `/tmp/cb-valid-${String(process.pid)}.sock`;
const ID = "01M0FP4NF24EWXR6V93NYDPHX8";

let server: RpcServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
  rmSync(SOCKET, { force: true });
});

const goodWrite = {
  session_id: ID,
  memory_kind: MemoryKind.SEMANTIC,
  type: "fact",
  title: "t",
  content: "c",
  project: null,
  parent_node_id: null,
};

describe("Socket argument validation", () => {
  it("should have a schema for every call on the surface, and no extras", () => {
    // Given / When / Then — enforced at compile time by `satisfies`, asserted here so the
    // failure is legible rather than a type error in an unrelated file.
    expect(schemaNames().sort()).toEqual(surfaceNames().sort());
  });

  it("should reject a write missing its required fields", () => {
    // Given — the exact call that previously reached the writer and blew up inside it.
    const bad = { session_id: ID };

    // When / Then
    expect(() => validateCall("write_memory", bad)).toThrow(InvalidArgsError);
  });

  it("should name the offending fields so a caller can fix the call", () => {
    // Given / When
    let issues: string[] = [];
    try {
      validateCall("write_memory", { session_id: ID });
    } catch (err) {
      issues = (err as InvalidArgsError).issues;
    }

    // Then
    expect(issues.join(" ")).toMatch(/memory_kind/);
    expect(issues.join(" ")).toMatch(/title/);
  });

  it("should reject an id that is not a ULID", () => {
    // Given / When / Then — ids reach queries, so shape is checked before they do.
    expect(() =>
      validateCall("restore_memory", { session_id: ID, id: "../../etc/passwd" }),
    ).toThrow(InvalidArgsError);
    expect(() => validateCall("fetch_nodes", { ids: ["not-an-id"] })).toThrow(InvalidArgsError);
  });

  it("should accept a valid call and hand back the parsed arguments", () => {
    // Given / When
    const parsed = validateCall("write_memory", goodWrite);

    // Then
    expect(parsed.title).toBe("t");
  });

  it("should let an unknown field through rather than failing a newer client", () => {
    // Given / When / Then — rejecting unknown keys makes the protocol harder to move,
    // not safer.
    expect(() => validateCall("write_memory", { ...goodWrite, invented_later: 1 })).not.toThrow();
  });

  it("should reject an empty query rather than searching for nothing", () => {
    // Given / When / Then
    expect(() => validateCall("search_memory", { query: "" })).toThrow(InvalidArgsError);
    expect(() => validateCall("search_memory", { query: "ok" })).not.toThrow();
  });

  it("should refuse a link weight outside its range", () => {
    // Given
    const base = { session_id: ID, src: ID, dst: ID, type: "relates_to" };

    // When / Then
    expect(() => validateCall("link_nodes", { ...base, weight: 5 })).toThrow(InvalidArgsError);
    expect(() => validateCall("link_nodes", { ...base, weight: 0.5 })).not.toThrow();
  });
});

describe("Validation over the socket", () => {
  it("should answer invalid-params, not an internal error, and never reach the handler", async () => {
    // Given
    let reached = 0;
    server = new RpcServer(
      surfaceMethods(() => {
        reached++;

        return Promise.resolve({});
      }),
    );
    await server.listen(SOCKET);

    // When
    const failure = rpcCall({ socketPath: SOCKET }, "write_memory", { session_id: ID });

    // Then
    await expect(failure).rejects.toThrow(/invalid arguments for write_memory/);
    expect(reached).toBe(0);
  });

  it("should carry the offending field list back to the caller", async () => {
    // Given
    server = new RpcServer(surfaceMethods(() => Promise.resolve({})));
    await server.listen(SOCKET);

    // When — the raw response, to see the JSON-RPC code and data rather than a thrown Error.
    const response = await rawCall("write_memory", { session_id: ID });

    // Then
    expect(response.error?.code).toBe(RPC_ERROR.invalidParams);
    expect((response.error?.data as { issues: string[] }).issues.join(" ")).toMatch(/content/);
  });

  it("should let a valid call through to the handler", async () => {
    // Given
    const seen: string[] = [];
    server = new RpcServer(
      surfaceMethods((name) => {
        seen.push(name);

        return Promise.resolve({ ok: true });
      }),
    );
    await server.listen(SOCKET);

    // When
    await rpcCall({ socketPath: SOCKET }, "write_memory", goodWrite);

    // Then
    expect(seen).toEqual(["write_memory"]);
  });
});

// A raw request, because rpcCall throws away the JSON-RPC envelope and these tests are
// about the code and data fields in it.
async function rawCall(
  method: string,
  params: Record<string, unknown>,
): Promise<{ error?: { code: number; data?: unknown } }> {
  const { connect } = await import("node:net");

  return new Promise((resolve, reject) => {
    const socket = connect(SOCKET);
    let buffer = "";

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;

      if (buffer.includes("\n")) {
        socket.destroy();
        resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as { error?: never });
      }
    });
    socket.on("error", reject);
  });
}
