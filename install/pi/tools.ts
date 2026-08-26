import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type { CerebriumBridge } from "./client.ts";
import { piToolName, sanitizeSchema, withSessionId } from "./schema.ts";
import { clip, describeCall, summarize } from "./summary.ts";

// Each MCP tool the server advertises becomes one pi tool. The schema, description and
// name all come from the server, so a tool added there appears here after a restart with
// nothing to edit — the bridge never carries its own copy of the catalogue.

export interface BridgeState {
  sessionId: string | null;
  checkpointed: boolean;
  calls: number;
}

export interface CerebriumToolDetails {
  tool: string;
  summary: string;
  truncated: boolean;
  bytes: number;
}

const GUIDELINES = [
  "Search cerebrium_search before answering from scratch and before writing a new memory; it is the durable record of what was already learned.",
  "Write durable findings back with cerebrium_write, attached to an exact live parent_node_id, and connect them with cerebrium_link.",
  "In an indexed repository, use cerebrium_code_lookup or cerebrium_search with types:['symbol'] before grepping or reading whole files.",
  "Call cerebrium_checkpoint before ending a substantial work block.",
];

function firstSentence(description: string, max = 140): string {
  const flat = description.replace(/\s+/g, " ").trim();
  const stop = flat.search(/\.\s/);
  const head = stop === -1 ? flat : flat.slice(0, stop + 1);
  return head.length > max ? `${head.slice(0, max - 1)}…` : head;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Registered tools outlive one connection: the definition closes over the bridge, so a
 * server that was restarted between calls is invisible to the model.
 */
export function registerBridgeTool(
  pi: ExtensionAPI,
  bridge: CerebriumBridge,
  state: BridgeState,
  tool: { name: string; description: string; inputSchema: Record<string, unknown> },
  autoSessionId: boolean,
): string {
  const schema = sanitizeSchema(tool.inputSchema);
  const name = piToolName(tool.name);

  const definition: ToolDefinition<TSchema, CerebriumToolDetails> = {
    name,
    label: name,
    description: tool.description,
    promptSnippet: firstSentence(tool.description),
    promptGuidelines: tool.name === "search" ? GUIDELINES : undefined,
    parameters: schema,

    // pi validates arguments against the schema before `execute` runs, so a missing
    // `session_id` has to be filled in here or the call never reaches the server.
    prepareArguments(args) {
      const given = asRecord(args);
      return autoSessionId ? withSessionId(given, state.sessionId, schema) : given;
    },

    async execute(_toolCallId, params, signal) {
      const args = asRecord(params);
      const answer = await bridge.call(tool.name, args, { signal });
      state.calls += 1;
      if (tool.name === "checkpoint" && !answer.isError) state.checkpointed = true;
      if (answer.isError) throw new Error(answer.text || `${tool.name} failed`);

      const clipped = clip(answer.text);
      return {
        content: [{ type: "text", text: clipped.text }],
        details: {
          tool: tool.name,
          summary: summarize(answer.text),
          truncated: clipped.truncated,
          bytes: clipped.totalBytes,
        },
      };
    },

    renderCall(args, theme) {
      const line = describeCall(asRecord(args));

      const label = theme.fg("accent", name);
      return new Text(line === "" ? label : `${label} ${theme.fg("dim", line)}`, 0, 0);
    },

    renderResult(result, options, theme) {
      const info = result.details;
      if (options.expanded) {
        const body = result.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("\n");
        return new Text(body, 0, 0);
      }
      const note = info.truncated ? theme.fg("warning", " (clipped)") : "";
      return new Text(`${theme.fg("success", info.summary)}${note}`, 0, 0);
    },
  };

  pi.registerTool(definition);
  return name;
}
