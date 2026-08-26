import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CerebriumBridge } from "@install/pi/client.ts";
import {
  configPath,
  DEFAULT_OPTIONS,
  parseOptions,
  projectForCwd,
  resolveConfig,
  serverPath,
} from "@install/pi/config.ts";
import { stripMarkers, systemPromptBlock } from "@install/pi/rules.ts";
import { mcpToolName, piToolName, sanitizeSchema, withSessionId } from "@install/pi/schema.ts";
import { clip, describeCall, summarize } from "@install/pi/summary.ts";
import { registerBridgeTool, type BridgeState } from "@install/pi/tools.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const STUB = join(REPO, "test", "fixtures", "pi-stub-server.mjs");
const SESSION = "01M0Y9C8Y8HPM5BKY6SDNMDYJS";

let home: string;

function writeConfig(value: unknown): void {
  const path = configPath(home, {});
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pi-bridge-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("resolveConfig", () => {
  it("should fall back to this working tree's bundle when no config file exists", () => {
    // Given / When
    const resolved = resolveConfig({ repoRoot: REPO, home, env: {}, execPath: "/usr/bin/node" });

    // Then
    expect(resolved.source).toBe("repository defaults");
    expect(resolved.launch.command).toBe("/usr/bin/node");
    expect(resolved.launch.args).toEqual([serverPath(REPO)]);
    expect(resolved.options).toEqual(DEFAULT_OPTIONS);
  });

  it("should prefer the pinned runtime and store recorded by setup", () => {
    // Given
    writeConfig({
      command: "/pinned/node",
      args: ["/checkout/dist/server.js"],
      env: { MEMORY_DB_PATH: "/store/memory.db" },
    });

    // When
    const resolved = resolveConfig({ repoRoot: REPO, home, env: {} });

    // Then
    expect(resolved.source).toBe("config file");
    expect(resolved.launch.command).toBe("/pinned/node");
    expect(resolved.launch.args).toEqual(["/checkout/dist/server.js"]);
    expect(resolved.launch.env.MEMORY_DB_PATH).toBe("/store/memory.db");
  });

  it("should layer the config file over an exported environment rather than replacing it", () => {
    // Given
    writeConfig({ command: "/pinned/node", env: { MEMORY_DB_PATH: "/store/memory.db" } });

    // When
    const resolved = resolveConfig({
      repoRoot: REPO,
      home,
      env: { MEMORY_DB_PATH: "/ignored.db", MEMORY_EMBED_PROVIDER: "local", PATH: "/bin" },
    });

    // Then
    expect(resolved.launch.env).toEqual({
      MEMORY_DB_PATH: "/store/memory.db",
      MEMORY_EMBED_PROVIDER: "local",
    });
  });

  it("should ignore a malformed config file instead of failing the session", () => {
    // Given
    const path = configPath(home, {});
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json");

    // When
    const resolved = resolveConfig({ repoRoot: REPO, home, env: {} });

    // Then
    expect(resolved.source).toBe("repository defaults");
  });

  it("should keep every option on by default and honour the ones that are set", () => {
    // Given / When
    const parsed = parseOptions({ greet: false, autoSessionId: false });

    // Then
    expect(parsed).toEqual({ ...DEFAULT_OPTIONS, greet: false, autoSessionId: false });
  });
});

describe("projectForCwd", () => {
  it("should name the declared code root the working directory sits in", () => {
    // Given / When / Then
    expect(projectForCwd("cerebrium=/repos/cerebrium", "/repos/cerebrium/src")).toBe("cerebrium");
  });

  it("should prefer the innermost root when two are nested", () => {
    // Given
    const roots = "outer=/repos,inner=/repos/cerebrium";

    // When / Then
    expect(projectForCwd(roots, "/repos/cerebrium/src")).toBe("inner");
  });

  it("should invent nothing for a directory no root declares", () => {
    // Given / When / Then
    expect(projectForCwd("cerebrium=/repos/cerebrium", "/tmp/elsewhere")).toBeUndefined();
    expect(projectForCwd(undefined, "/repos/cerebrium")).toBeUndefined();
  });
});

describe("sanitizeSchema", () => {
  it("should drop the keywords providers reject and keep the ones they need", () => {
    // Given
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      properties: {
        session_id: { type: "string", pattern: "^[0-7]", description: "the id" },
        kinds: { type: "array", items: { type: "string", enum: ["semantic"] } },
      },
      required: ["session_id"],
    };

    // When
    const sanitized = sanitizeSchema(schema);

    // Then
    expect(sanitized.$schema).toBeUndefined();
    expect(sanitized.additionalProperties).toBeUndefined();
    expect(sanitized).toMatchObject({
      type: "object",
      required: ["session_id"],
      properties: {
        session_id: { type: "string", description: "the id" },
        kinds: { type: "array", items: { type: "string", enum: ["semantic"] } },
      },
    });
    expect((sanitized.properties as Record<string, object>).session_id).not.toHaveProperty(
      "pattern",
    );
  });

  it("should answer with an object schema even for a tool that declares nothing", () => {
    // Given / When / Then
    expect(sanitizeSchema(undefined)).toEqual({ type: "object", properties: {} });
  });

  it("should inline a local $ref so the argument keeps its description", () => {
    // Given
    const schema = {
      type: "object",
      properties: {
        src: { type: "string", description: "an exact node id" },
        dst: { $ref: "#/properties/src" },
      },
    };

    // When
    const sanitized = sanitizeSchema(schema);

    // Then
    expect((sanitized.properties as Record<string, unknown>).dst).toEqual({
      type: "string",
      description: "an exact node id",
    });
  });

  it("should survive a $ref that points nowhere or at itself", () => {
    // Given
    const dangling = { type: "object", properties: { a: { $ref: "#/nope" } } };
    const cyclic = {
      type: "object",
      properties: { a: { $ref: "#/properties/b" }, b: { $ref: "#/properties/a" } },
    };

    // When / Then
    expect(sanitizeSchema(dangling).properties).toEqual({ a: {} });
    expect(() => sanitizeSchema(cyclic)).not.toThrow();
  });
});

describe("tool names", () => {
  it("should prefix memory tools so they cannot collide with pi's own write and get", () => {
    // Given / When / Then
    expect(piToolName("write")).toBe("cerebrium_write");
    expect(mcpToolName("cerebrium_write")).toBe("write");
    expect(mcpToolName("write")).toBeNull();
  });
});

describe("withSessionId", () => {
  const schema = { type: "object", properties: { session_id: { type: "string" } } };

  it("should fill in the id the extension holds when the call omitted it", () => {
    // Given / When / Then
    expect(withSessionId({ query: "x" }, SESSION, schema)).toEqual({
      query: "x",
      session_id: SESSION,
    });
  });

  it("should leave an id the caller supplied alone", () => {
    // Given / When / Then
    expect(withSessionId({ session_id: "01OTHER" }, SESSION, schema).session_id).toBe("01OTHER");
  });

  it("should never invent an id for a tool that does not take one", () => {
    // Given
    const noSession = { type: "object", properties: { path: { type: "string" } } };

    // When / Then
    expect(withSessionId({ path: "/x" }, SESSION, noSession)).toEqual({ path: "/x" });
    expect(withSessionId({ query: "x" }, null, schema)).toEqual({ query: "x" });
  });
});

describe("summarize", () => {
  it("should read a session opening off its working set", () => {
    // Given
    const text = JSON.stringify({
      session_id: SESSION,
      working_set: { tasks: [1, 2], checkpoints: [], recent: [3] },
    });

    // When / Then
    expect(summarize(text)).toBe("session opened · 2 tasks, 1 recent");
  });

  it("should count search hits and name the best one", () => {
    // Given
    const text = JSON.stringify({ results: [{ title: "a node" }], total_matches: 39 });

    // When / Then
    expect(summarize(text)).toBe("1 of 39 hits · a node");
  });

  it("should name the node a write answered with", () => {
    // Given
    const text = JSON.stringify({ id: "01ABC", rev: 3, title: "a decision" });

    // When / Then
    expect(summarize(text)).toBe("01ABC (rev 3) · a decision");
  });

  it("should degrade to counters and then to a size instead of breaking", () => {
    // Given / When / Then
    expect(summarize(JSON.stringify({ nodes_total: 12, edges: 3 }))).toBe(
      "nodes_total 12, edges 3",
    );
    expect(summarize("not json at all")).toBe("15 B");
  });
});

describe("clip", () => {
  it("should leave a small answer untouched", () => {
    // Given / When
    const clipped = clip("small", 100, 10);

    // Then
    expect(clipped.truncated).toBe(false);
    expect(clipped.text).toBe("small");
  });

  it("should cut an oversized answer and say so", () => {
    // Given / When
    const clipped = clip("x".repeat(500), 100, 10);

    // Then
    expect(clipped.truncated).toBe(true);
    expect(clipped.totalBytes).toBe(500);
    expect(clipped.text).toContain("clipped by the cerebrium bridge");
  });
});

describe("describeCall", () => {
  it("should show the argument that says what the call is about", () => {
    // Given / When / Then
    expect(describeCall({ session_id: SESSION, query: "how does retrieval rank" })).toBe(
      "query: how does retrieval rank",
    );
    expect(describeCall({ session_id: SESSION })).toBe("");
  });
});

describe("rules", () => {
  it("should hand pi the always-on block without the managed markers", () => {
    // Given / When
    const block = systemPromptBlock(REPO);

    // Then
    expect(block).not.toContain("cerebrium:start");
    expect(block).not.toContain("cerebrium:end");
    expect(block).toContain("# Agent memory (Cerebrium)");
  });

  it("should tell the model the tools are prefixed in pi", () => {
    // Given / When / Then
    expect(systemPromptBlock(REPO)).toContain("cerebrium_search");
  });

  it("should return the text unchanged when there are no markers", () => {
    // Given / When / Then
    expect(stripMarkers("plain rules")).toBe("plain rules");
  });
});

describe("CerebriumBridge", () => {
  let bridge: CerebriumBridge;

  afterEach(async () => {
    await bridge.close();
  });

  it("should expose the catalogue the server advertises", async () => {
    // Given
    bridge = new CerebriumBridge({ command: process.execPath, args: [STUB], env: {} });

    // When
    const tools = await bridge.listTools();

    // Then
    expect(tools.map((tool) => tool.name)).toEqual(["session_start", "search", "boom", "die"]);
    expect(bridge.connected).toBe(true);
  });

  it("should hand the configured environment to the server it spawns", async () => {
    // Given
    bridge = new CerebriumBridge({
      command: process.execPath,
      args: [STUB],
      env: { STUB_LABEL: "from-config" },
    });

    // When
    const answer = await bridge.call("search", { session_id: SESSION, query: "x" });

    // Then
    expect(JSON.parse(answer.text)).toMatchObject({ label: "from-config" });
  });

  it("should report a tool error as an error rather than throwing", async () => {
    // Given
    bridge = new CerebriumBridge({ command: process.execPath, args: [STUB], env: {} });

    // When
    const answer = await bridge.call("boom", {});

    // Then
    expect(answer).toEqual({ text: "stub failure", isError: true });
  });

  it("should reconnect for the next call when the server died", async () => {
    // Given
    bridge = new CerebriumBridge({ command: process.execPath, args: [STUB], env: {} });
    await bridge.call("die", {});
    await new Promise((resolve) => setTimeout(resolve, 100));

    // When
    const answer = await bridge.call("search", { session_id: SESSION, query: "after death" });

    // Then
    expect(JSON.parse(answer.text)).toMatchObject({ echoed: { query: "after death" } });
  });
});

describe("registerBridgeTool", () => {
  let bridge: CerebriumBridge;
  let registered: ToolDefinition[];
  let state: BridgeState;

  const api = (): ExtensionAPI =>
    ({
      registerTool: (tool: ToolDefinition) => registered.push(tool),
    }) as unknown as ExtensionAPI;

  const register = (name: string, autoSessionId = true): ToolDefinition => {
    const tool = {
      name,
      description: "Echo the arguments back. First sentence. Second sentence.",
      inputSchema: {
        type: "object",
        properties: { session_id: { type: "string" }, query: { type: "string" } },
      },
    };
    registerBridgeTool(api(), bridge, state, tool, autoSessionId);
    return registered.at(-1)!;
  };

  beforeEach(() => {
    bridge = new CerebriumBridge({ command: process.execPath, args: [STUB], env: {} });
    registered = [];
    state = { sessionId: SESSION, checkpointed: false, calls: 0 };
  });

  afterEach(async () => {
    await bridge.close();
  });

  it("should register a prefixed tool with a one-line prompt snippet", () => {
    // Given / When
    const tool = register("search");

    // Then
    expect(tool.name).toBe("cerebrium_search");
    expect(tool.promptSnippet).toBe("Echo the arguments back.");
    expect(tool.promptGuidelines?.[0]).toContain("cerebrium_search");
  });

  it("should fill the session id in before pi validates the arguments", () => {
    // Given
    const tool = register("search");

    // When
    const prepared = tool.prepareArguments?.({ query: "x" }) as Record<string, unknown>;

    // Then
    expect(prepared).toEqual({ query: "x", session_id: SESSION });
  });

  it("should leave the arguments alone when auto session id is switched off", () => {
    // Given
    const tool = register("search", false);

    // When
    const prepared = tool.prepareArguments?.({ query: "x" }) as Record<string, unknown>;

    // Then
    expect(prepared).toEqual({ query: "x" });
  });

  it("should summarize what came back and count the call", async () => {
    // Given
    const tool = register("search");

    // When
    const result = await tool.execute(
      "call-1",
      { session_id: SESSION, query: "x" },
      undefined,
      undefined,
      {} as never,
    );

    // Then
    expect(result.details).toMatchObject({ tool: "search", summary: "1 of 1 hits · stub hit" });
    expect(state.calls).toBe(1);
  });

  it("should raise a failed call as a tool error", async () => {
    // Given
    const tool = register("boom");

    // When / Then
    await expect(tool.execute("call-2", {}, undefined, undefined, {} as never)).rejects.toThrow(
      "stub failure",
    );
  });

  it("should remember that this session checkpointed", async () => {
    // Given
    const tool = register("checkpoint");

    // When
    await tool.execute("call-3", { session_id: SESSION }, undefined, undefined, {} as never);

    // Then
    expect(state.checkpointed).toBe(true);
  });
});
