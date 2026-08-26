import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { CerebriumBridge } from "./client.ts";
import {
  projectForCwd,
  repoRootFromHere,
  resolveConfig,
  skillRoot,
  type ResolvedConfig,
} from "./config.ts";
import { systemPromptBlock } from "./rules.ts";
import { greeting, summarize } from "./summary.ts";
import { registerBridgeTool, type BridgeState } from "./tools.ts";

// Cerebrium in pi. pi has no MCP client, no rules file it manages for you and no session
// hook, so the four surfaces every other host wires separately are all here: the bridge
// spawns the server and registers its tools, `resources_discover` hands pi this working
// tree's skill, `before_agent_start` chains the always-on block onto the system prompt, and
// `session_start` opens the memory session so the model is handed a real session id and a
// working set instead of a reminder to go and fetch one.

const STATUS_KEY = "cerebrium";
const STATUS_ENTRY = "cerebrium-status";
const SESSION_MESSAGE = "cerebrium-session";

interface StatusCard {
  title: string;
  lines: string[];
}

function shortId(id: string): string {
  return id.slice(-6);
}

export default function (pi: ExtensionAPI): void {
  const repoRoot = repoRootFromHere();
  const state: BridgeState = { sessionId: null, checkpointed: false, calls: 0 };

  let bridge: CerebriumBridge | null = null;
  let config: ResolvedConfig | null = null;
  let registered: string[] = [];
  let rules: string | null = null;

  pi.registerFlag("no-cerebrium", {
    description: "Start without the Cerebrium memory bridge",
    type: "boolean",
    default: false,
  });

  pi.registerEntryRenderer(STATUS_ENTRY, (entry, _options, theme) => {
    const card = entry.data as StatusCard;
    const box = new Box(1, 0);
    box.addChild(new Text(theme.fg("accent", theme.bold(card.title)), 0, 0));
    for (const line of card.lines) box.addChild(new Text(theme.fg("dim", line), 0, 0));
    return box;
  });

  const disabled = (): boolean => pi.getFlag("no-cerebrium") === true;

  const status = (ui: ExtensionUIContext, hasUI: boolean): void => {
    if (!hasUI) return;
    if (bridge?.connected !== true) {
      ui.setStatus(STATUS_KEY, "memory: offline");
      return;
    }
    const session = state.sessionId === null ? "no session" : shortId(state.sessionId);
    ui.setStatus(STATUS_KEY, `memory: ${session} · ${registered.length} tools`);
  };

  const card = (title: string, lines: string[]): void => {
    pi.appendEntry(STATUS_ENTRY, { title, lines } satisfies StatusCard);
  };

  const connect = async (ctx: ExtensionContext): Promise<void> => {
    const resolved = resolveConfig({ repoRoot });
    config = resolved;
    rules = resolved.options.rules ? readRules(repoRoot) : null;

    const started = new CerebriumBridge(resolved.launch, "pi");
    bridge = started;

    let catalogue;
    try {
      catalogue = await started.listTools();
    } catch (err) {
      bridge = null;
      if (ctx.hasUI) {
        ctx.ui.setStatus(STATUS_KEY, "memory: unavailable");
        ctx.ui.notify(
          `Cerebrium bridge failed to start: ${String(err)}. Run \`npm run agent:setup -- --host pi --apply\` in ${repoRoot}.`,
          "error",
        );
      }
      return;
    }

    registered = catalogue.map((tool) =>
      registerBridgeTool(pi, started, state, tool, resolved.options.autoSessionId),
    );
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...registered])]);
    status(ctx.ui, ctx.hasUI);
  };

  const greet = async (ctx: ExtensionContext): Promise<void> => {
    const active = bridge;
    const resolved = config;
    if (active === null || resolved === null) return;
    if (!resolved.options.greet) return;
    const project = projectForCwd(resolved.launch.env.MEMORY_CODE_ROOTS, ctx.cwd);
    try {
      const answer = await active.call("session_start", project === undefined ? {} : { project });
      if (answer.isError) throw new Error(answer.text);
      state.sessionId = readSessionId(answer.text);
      pi.sendMessage(
        {
          customType: SESSION_MESSAGE,
          content: greeting(answer.text),
          display: true,
        },
        { deliverAs: "nextTurn" },
      );
      status(ctx.ui, ctx.hasUI);
    } catch (err) {
      if (ctx.hasUI) ctx.ui.notify(`Cerebrium session_start failed: ${String(err)}`, "warning");
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    state.sessionId = null;
    state.checkpointed = false;
    state.calls = 0;
    registered = [];
    if (disabled()) return;
    await connect(ctx);
    await greet(ctx);
  });

  pi.on("resources_discover", () => {
    if (disabled() || config?.options.skill === false) return;
    return { skillPaths: [skillRoot(repoRoot)] };
  });

  pi.on("before_agent_start", (event) => {
    if (rules === null) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${rules}` };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI && state.calls > 0 && !state.checkpointed) {
      ctx.ui.notify(
        "Cerebrium: this session wrote no checkpoint — the next one starts without it.",
        "warning",
      );
    }
    await bridge?.close();
    bridge = null;
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerCommand("cerebrium", {
    description: "Cerebrium memory: status | restart | reindex",
    getArgumentCompletions: (prefix) => {
      const items = ["status", "restart", "reindex"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim() === "" ? "status" : args.trim();
      if (action === "restart") {
        await bridge?.close();
        bridge = null;
        await connect(ctx);
        await greet(ctx);
        card("cerebrium restart", [
          registered.length === 0
            ? "bridge is still down"
            : `reconnected · ${registered.length} tools`,
        ]);
        return;
      }
      if (action === "reindex") {
        await reindex(ctx);
        return;
      }
      await report(ctx);
    },
  });

  const reindex = async (ctx: ExtensionContext): Promise<void> => {
    if (bridge === null || state.sessionId === null) {
      card("cerebrium reindex", ["bridge is offline — run /cerebrium restart"]);
      return;
    }
    try {
      const answer = await bridge.call("code_index", {
        session_id: state.sessionId,
        path: ctx.cwd,
      });
      card("cerebrium reindex", [ctx.cwd, summarize(answer.text)]);
    } catch (err) {
      card("cerebrium reindex", [`failed: ${String(err)}`]);
    }
  };

  const report = async (ctx: ExtensionContext): Promise<void> => {
    const lines: string[] = [];
    lines.push(`config: ${config?.source ?? "not resolved"} (${config?.configPath ?? "-"})`);
    lines.push(
      `server: ${config === null ? "-" : [config.launch.command, ...config.launch.args].join(" ")}`,
    );
    lines.push(`store: ${config?.launch.env.MEMORY_DB_PATH ?? "server default"}`);
    lines.push(`session: ${state.sessionId ?? "none"} · ${state.calls} calls`);
    lines.push(`tools: ${registered.length}`);

    if (bridge !== null) {
      try {
        const answer = await bridge.call("stats", { session_id: state.sessionId ?? undefined });
        lines.push(`stats: ${summarize(answer.text)}`);
      } catch (err) {
        lines.push(`stats: unavailable (${String(err)})`);
      }
      for (const line of bridge.diagnostics.slice(-3)) lines.push(`stderr: ${line}`);
    } else {
      lines.push("bridge: offline");
    }
    card("cerebrium", lines);
    status(ctx.ui, ctx.hasUI);
  };
}

function readRules(repoRoot: string): string | null {
  try {
    return systemPromptBlock(repoRoot);
  } catch {
    return null;
  }
}

function readSessionId(text: string): string | null {
  try {
    const payload: unknown = JSON.parse(text);
    if (typeof payload !== "object" || payload === null) return null;
    const id = (payload as Record<string, unknown>).session_id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}
