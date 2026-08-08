import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRpcResponses, storeWritable } from "@scripts/agent-verify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-verify-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseRpcResponses", () => {
  it("should read every response regardless of the order they arrive in", () => {
    // Given
    const stream = [
      '{"jsonrpc":"2.0","id":1,"result":{}}',
      '{"jsonrpc":"2.0","id":3,"result":{"tools":[{"name":"search"}]}}',
      '{"jsonrpc":"2.0","id":2,"result":{"content":[]}}',
    ].join("\n");

    // When
    const parsed = parseRpcResponses(stream);

    // Then
    expect(parsed.map((r) => r.id)).toEqual([1, 3, 2]);
  });

  it("should ignore a partial line rather than throwing", () => {
    // Given / When
    const parsed = parseRpcResponses('{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","id');

    // Then
    expect(parsed).toHaveLength(1);
  });

  it("should ignore non-protocol noise on the stream", () => {
    // Given / When
    const parsed = parseRpcResponses('warning: something\n{"jsonrpc":"2.0","id":1,"result":{}}');

    // Then
    expect(parsed.map((r) => r.id)).toEqual([1]);
  });
});

describe("storeWritable", () => {
  it("should accept a store whose directory does not exist yet", () => {
    // Given / When / Then
    expect(storeWritable(join(dir, "not-created-yet", "memory.db"))).toBe(true);
  });

  it("should accept a store in an existing writable directory", () => {
    // Given / When / Then
    expect(storeWritable(join(dir, "memory.db"))).toBe(true);
  });

  it("should reject a store under a path that cannot be reached", () => {
    // Given / When / Then
    expect(storeWritable("/proc/nonexistent/memory.db")).toBe(false);
  });
});

describe("Antigravity session reminder", () => {
  function invoke(invocationNum: number): Record<string, unknown> {
    const output = execFileSync(
      "node",
      [join(REPO, "install", "hooks", "session-start.mjs"), "--host", "antigravity"],
      { input: JSON.stringify({ invocationNum }), encoding: "utf8" },
    );
    return JSON.parse(output) as Record<string, unknown>;
  }

  it("should inject the expanded reminder on zero-indexed invocation 0", () => {
    // Given / When
    const first = JSON.stringify(invoke(0));

    // Then
    expect(first).toContain("session_start");
    expect(first).toContain("code_lookup");
    expect(first).toContain("parent_node_id");
  });

  it("should emit an empty payload on invocation 1", () => {
    // Given / When / Then
    expect(invoke(1)).toEqual({});
  });
});
