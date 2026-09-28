import { rmSync } from "node:fs";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RpcServer } from "@/presentation/rpc";

const SOCKET = `/tmp/cb-cap-${String(process.pid)}.sock`;

let rpc: RpcServer | null = null;

afterEach(async () => {
  await rpc?.close();
  rpc = null;
  rmSync(SOCKET, { force: true });
});

function frame(id: number, bytes: number): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method: "echo", params: { pad: "x".repeat(bytes) } })}\n`;
}

// Writes `payload` in one go and collects every line answered until the socket closes or
// `expected` answers arrive.
function exchange(
  payload: string,
  expected: number,
): Promise<{ lines: string[]; closed: boolean }> {
  return new Promise((resolve) => {
    const socket = connect(SOCKET);
    const lines: string[] = [];
    let buffer = "";
    let closed = false;

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;

      let newline = buffer.indexOf("\n");

      while (newline >= 0) {
        lines.push(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }

      if (lines.length >= expected) {
        socket.end();
        resolve({ lines, closed });
      }
    });
    socket.on("close", () => {
      closed = true;
      resolve({ lines, closed });
    });
    socket.on("error", () => undefined);
    socket.write(payload);
  });
}

describe("The socket's request size bound", () => {
  it("should answer several large frames that arrive together", async () => {
    // Given
    rpc = new RpcServer({ echo: () => Promise.resolve("ok") });
    await rpc.listen(SOCKET);

    // When
    const { lines } = await exchange(frame(1, 600_000) + frame(2, 600_000), 2);

    // Then
    expect(lines.map((l) => (JSON.parse(l) as { id: number }).id).sort()).toEqual([1, 2]);
  });

  it("should close the connection on one frame over the bound", async () => {
    // Given
    rpc = new RpcServer({ echo: () => Promise.resolve("ok") });
    await rpc.listen(SOCKET);

    // When
    const { lines, closed } = await exchange(frame(1, 1_100_000), 1);

    // Then
    expect(closed).toBe(true);
    expect(lines.filter((l) => !l.includes("request too large"))).toEqual([]);
  });
});
