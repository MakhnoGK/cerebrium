import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  EntryRenderer,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  RegisteredCommand,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import cerebrium from "@install/pi/index.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Drives the extension the way pi does — fire its events, run its command, render its rows —
// against the stub MCP server, so the wiring is exercised without a pi process or a database.

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const STUB = join(REPO, "test", "fixtures", "pi-stub-server.mjs");

interface Harness {
  api: ExtensionAPI;
  tools: ToolDefinition[];
  entries: { type: string; data: unknown }[];
  messages: { content: string; customType: string }[];
  notices: { message: string; type: string }[];
  statuses: (string | undefined)[];
  renderers: Map<string, EntryRenderer>;
  commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
  active: string[];
  ctx: ExtensionContext;
}

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function harness(cwd: string): Harness {
  const state: Harness = {
    tools: [],
    entries: [],
    messages: [],
    notices: [],
    statuses: [],
    renderers: new Map(),
    commands: new Map(),
    handlers: new Map(),
    active: ["read", "bash"],
  } as unknown as Harness;

  state.api = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      state.handlers.set(event, handler);
    },
    registerTool: (tool: ToolDefinition) => state.tools.push(tool),
    registerCommand: (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
      state.commands.set(name, options);
    },
    registerFlag: () => undefined,
    getFlag: () => false,
    registerEntryRenderer: (type: string, renderer: EntryRenderer) => {
      state.renderers.set(type, renderer);
    },
    appendEntry: (type: string, data: unknown) => state.entries.push({ type, data }),
    sendMessage: (message: { content: string; customType: string }) => state.messages.push(message),
    getActiveTools: () => state.active,
    setActiveTools: (names: string[]) => {
      state.active = names;
    },
  } as unknown as ExtensionAPI;

  state.ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, type = "info") => state.notices.push({ message, type }),
      setStatus: (_key: string, text: string | undefined) => state.statuses.push(text),
    },
  } as unknown as ExtensionContext;

  return state;
}

let home: string;
let agentDir: string;
let previousAgentDir: string | undefined;

function fire(pi: Harness, event: string, payload: unknown = {}): Promise<unknown> {
  const handler = pi.handlers.get(event);
  if (handler === undefined) throw new Error(`no handler for ${event}`);
  return Promise.resolve(handler(payload, pi.ctx));
}

async function started(cwd = REPO): Promise<Harness> {
  const pi = harness(cwd);
  cerebrium(pi.api);
  await fire(pi, "session_start", { reason: "startup" });
  return pi;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pi-extension-"));
  agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "cerebrium.json"),
    JSON.stringify({
      command: process.execPath,
      args: [STUB],
      env: { MEMORY_CODE_ROOTS: `cerebrium=${REPO}` },
    }),
  );
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(home, { recursive: true, force: true });
});

describe("session start", () => {
  it("should register one prefixed pi tool per tool the server advertises", async () => {
    // Given / When
    const pi = await started();

    // Then
    expect(pi.tools.map((tool) => tool.name)).toEqual([
      "cerebrium_session_start",
      "cerebrium_search",
      "cerebrium_boom",
      "cerebrium_die",
    ]);
    await fire(pi, "session_shutdown", { reason: "quit" });
  });

  it("should enable the new tools without dropping the ones pi already had", async () => {
    // Given / When
    const pi = await started();

    // Then
    expect(pi.active).toContain("read");
    expect(pi.active).toContain("cerebrium_search");
    await fire(pi, "session_shutdown", { reason: "quit" });
  });

  it("should hand the model the session id and working set it opened", async () => {
    // Given / When
    const pi = await started();

    // Then
    const posted = pi.messages.at(0)!;
    expect(posted.customType).toBe("cerebrium-session");
    expect(posted.content).toContain("01M0Y9C8Y8HPM5BKY6SDNMDYJS");
    expect(posted.content).toContain("stub task");
    await fire(pi, "session_shutdown", { reason: "quit" });
  });

  it("should report the session in the status line", async () => {
    // Given / When
    const pi = await started();

    // Then
    expect(pi.statuses.at(-1)).toContain("4 tools");
    await fire(pi, "session_shutdown", { reason: "quit" });
  });

  it("should say so rather than throw when the server cannot be launched", async () => {
    // Given
    writeFileSync(
      join(agentDir, "cerebrium.json"),
      JSON.stringify({ command: process.execPath, args: [join(home, "absent.mjs")], env: {} }),
    );

    // When
    const pi = await started();

    // Then
    expect(pi.tools).toEqual([]);
    expect(pi.notices.at(0)?.type).toBe("error");
    expect(pi.statuses.at(-1)).toBe("memory: unavailable");
  });
});

describe("resources and rules", () => {
  it("should offer this working tree's skill directory to pi", async () => {
    // Given
    const pi = await started();

    // When
    const result = (await fire(pi, "resources_discover", { reason: "startup" })) as {
      skillPaths: string[];
    };

    // Then
    expect(result.skillPaths).toEqual([join(REPO, "skill")]);
    await fire(pi, "session_shutdown", { reason: "quit" });
  });

  it("should chain the always-on block onto the system prompt it was given", async () => {
    // Given
    const pi = await started();

    // When
    const result = (await fire(pi, "before_agent_start", { systemPrompt: "BASE PROMPT" })) as {
      systemPrompt: string;
    };

    // Then
    expect(result.systemPrompt.startsWith("BASE PROMPT")).toBe(true);
    expect(result.systemPrompt).toContain("# Agent memory (Cerebrium)");
    expect(result.systemPrompt).toContain("cerebrium_search");
    await fire(pi, "session_shutdown", { reason: "quit" });
  });

  it("should leave the prompt alone when the bridge never came up", async () => {
    // Given
    writeFileSync(
      join(agentDir, "cerebrium.json"),
      JSON.stringify({ command: process.execPath, args: [join(home, "absent.mjs")], env: {} }),
    );
    const pi = await started();

    // When
    const result = await fire(pi, "before_agent_start", { systemPrompt: "BASE PROMPT" });

    // Then
    expect(result).toBeUndefined();
  });
});

describe("/cerebrium", () => {
  it("should render a status card naming the store, the session and the tools", async () => {
    // Given
    const pi = await started();

    // When
    await pi.commands.get("cerebrium")!.handler("status", pi.ctx as ExtensionCommandContext);

    // Then
    const card = pi.entries.at(-1)!;
    const lines = (card.data as { lines: string[] }).lines.join("\n");
    expect(card.type).toBe("cerebrium-status");
    expect(lines).toContain("01M0Y9C8Y8HPM5BKY6SDNMDYJS");
    expect(lines).toContain("tools: 4");
    await fire(pi, "session_shutdown", { reason: "quit" });
  });

  it("should render that card through the registered entry renderer", async () => {
    // Given
    const pi = await started();
    await pi.commands.get("cerebrium")!.handler("", pi.ctx as ExtensionCommandContext);
    const entry = pi.entries.at(-1)!;

    // When
    const component = pi.renderers.get("cerebrium-status")!(
      { type: "custom", customType: entry.type, data: entry.data } as never,
      { expanded: false },
      theme,
    );

    // Then
    expect(component?.render(80).join("\n")).toContain("cerebrium");
    await fire(pi, "session_shutdown", { reason: "quit" });
  });

  it("should reconnect on restart and keep answering", async () => {
    // Given
    const pi = await started();

    // When
    await pi.commands.get("cerebrium")!.handler("restart", pi.ctx as ExtensionCommandContext);

    // Then
    expect((pi.entries.at(-1)!.data as { lines: string[] }).lines[0]).toContain("reconnected");
    await fire(pi, "session_shutdown", { reason: "quit" });
  });

  it("should complete every argument it accepts", async () => {
    // Given
    const pi = await started();

    // When
    const items = await pi.commands.get("cerebrium")!.getArgumentCompletions?.("re");

    // Then
    expect(items?.map((item: { value: string }) => item.value)).toEqual(["restart", "reindex"]);
    await fire(pi, "session_shutdown", { reason: "quit" });
  });
});

describe("tool rows", () => {
  it("should render a call and its collapsed and expanded results", async () => {
    // Given
    const pi = await started();
    const search = pi.tools.find((tool) => tool.name === "cerebrium_search")!;
    const args = { query: "how does ranking work" };

    // When
    const result = await search.execute("call-1", args, undefined, undefined, pi.ctx);
    const call = search.renderCall!(args, theme, { args, toolCallId: "call-1" } as never);
    const collapsed = search.renderResult!(result, { expanded: false, isPartial: false }, theme, {
      args,
      toolCallId: "call-1",
    } as never);
    const expanded = search.renderResult!(result, { expanded: true, isPartial: false }, theme, {
      args,
      toolCallId: "call-1",
    } as never);

    // Then
    expect(call.render(80).join("")).toContain("how does ranking work");
    expect(collapsed.render(80).join("")).toContain("1 of 1 hits");
    expect(expanded.render(400).join("")).toContain("stub hit");
    await fire(pi, "session_shutdown", { reason: "quit" });
  });
});

describe("shutdown", () => {
  it("should warn when a session that used memory never checkpointed", async () => {
    // Given
    const pi = await started();
    const search = pi.tools.find((tool) => tool.name === "cerebrium_search")!;
    await search.execute("call-1", { query: "x" }, undefined, undefined, pi.ctx);

    // When
    await fire(pi, "session_shutdown", { reason: "quit" });

    // Then
    expect(pi.notices.at(-1)?.message).toContain("no checkpoint");
    expect(pi.statuses.at(-1)).toBeUndefined();
  });

  it("should stay quiet about a session that never touched memory", async () => {
    // Given
    const pi = await started();

    // When
    await fire(pi, "session_shutdown", { reason: "quit" });

    // Then
    expect(pi.notices).toEqual([]);
  });
});
