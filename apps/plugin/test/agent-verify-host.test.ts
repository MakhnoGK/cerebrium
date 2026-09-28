import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pluginServerPath } from "@plugin/scripts/agent-host-entry";
import { verifyHostEntry } from "@plugin/scripts/agent-verify";
import { pluginBundle } from "./plugin-bundle";

let dir: string;
let kernel: Server;
let port: number;
let metas: Record<string, unknown>[];

function listen(): Promise<void> {
  kernel = createServer((socket) => {
    let buffer = "";

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;

      let newline = buffer.indexOf("\n");

      while (newline >= 0) {
        const request = JSON.parse(buffer.slice(0, newline)) as {
          id: number;
          method: string;
          meta?: Record<string, unknown>;
        };
        buffer = buffer.slice(newline + 1);

        if (request.method === "start_session") metas.push(request.meta ?? {});
        socket.write(
          `${JSON.stringify(
            request.method === "initialize"
              ? { jsonrpc: "2.0", id: request.id, result: { protocol: 2 } }
              : { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "fake host" } },
          )}\n`,
        );
        newline = buffer.indexOf("\n");
      }
    });
  });

  return new Promise((resolve) =>
    kernel.listen(0, "127.0.0.1", () => {
      port = (kernel.address() as { port: number }).port;
      resolve();
    }),
  );
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "cb-verify-host-"));
  metas = [];
  await listen();
});

afterEach(async () => {
  await new Promise((resolve) => kernel.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

describe("verifyHostEntry", () => {
  it("should start the host session under the client name it announced", async () => {
    // Given
    const repoRoot = join(dir, "repo");
    mkdirSync(join(repoRoot, "apps", "plugin", "dist"), { recursive: true });
    copyFileSync((await pluginBundle()).server, pluginServerPath(repoRoot));
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, "cbr_x\n", { mode: 0o600 });

    // When
    const result = await verifyHostEntry({
      home: dir,
      repoRoot,
      nodePath: process.execPath,
      kernelUrl: `tcp://127.0.0.1:${String(port)}`,
      tokenFile,
      hasCommand: () => false,
    });

    // Then
    expect(result.detail).toContain("fake host");
    expect(metas).toEqual([expect.objectContaining({ client: "agent-setup", version: "1" })]);
  });
});
