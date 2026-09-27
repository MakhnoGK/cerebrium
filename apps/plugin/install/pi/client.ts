import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { LaunchConfig } from "./config.ts";

// pi ships no MCP layer, so this is it: one child server per pi session, spoken to over
// stdio exactly as Claude Code or Antigravity would. The child is spawned lazily at session
// start and killed at shutdown, and a dropped transport is not fatal — the next call
// reconnects, because a memory that disappears mid-session is worse than a slow one.

export interface BridgeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface BridgeCall {
  text: string;
  isError: boolean;
}

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const SLOW_TOOLS: Record<string, number> = {
  code_index: 900_000,
  consolidate_apply: 600_000,
  consolidate_retry: 600_000,
  job_submit: 300_000,
};
const STDERR_TAIL = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return "";
  return result.content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .filter((part) => part !== "")
    .join("\n");
}

export function timeoutFor(mcpName: string, override?: number): number {
  return override ?? SLOW_TOOLS[mcpName] ?? DEFAULT_TIMEOUT_MS;
}

// Loaded as raw TypeScript by pi's jiti and by `node --experimental-strip-types` in
// verification, so everything here stays erasable: no parameter properties, no decorators.
export class CerebriumBridge {
  private client: Client | null = null;
  private starting: Promise<Client> | null = null;
  private stderrTail: string[] = [];
  private failure: string | null = null;
  private readonly launch: LaunchConfig;
  private readonly clientName: string;

  constructor(launch: LaunchConfig, clientName = "pi") {
    this.launch = launch;
    this.clientName = clientName;
  }

  get connected(): boolean {
    return this.client !== null;
  }

  get lastError(): string | null {
    return this.failure;
  }

  get diagnostics(): string[] {
    return [...this.stderrTail];
  }

  async connect(): Promise<Client> {
    if (this.client !== null) return this.client;
    this.starting ??= this.start();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async start(): Promise<Client> {
    const transport = new StdioClientTransport({
      command: this.launch.command,
      args: this.launch.args,
      env: { ...getDefaultEnvironment(), ...this.launch.env },
      stderr: "pipe",
    });
    const client = new Client({ name: this.clientName, version: "1" }, { capabilities: {} });
    client.onclose = () => {
      this.client = null;
    };

    try {
      await client.connect(transport);
    } catch (err) {
      this.failure = String(err);
      throw err;
    }

    transport.stderr?.on("data", (chunk: Buffer) => {
      this.absorb(chunk.toString("utf8"));
    });
    this.failure = null;
    this.client = client;
    return client;
  }

  private absorb(chunk: string): void {
    const lines = chunk.split("\n").filter((line) => line.trim() !== "");
    this.stderrTail = [...this.stderrTail, ...lines].slice(-STDERR_TAIL);
  }

  async listTools(): Promise<BridgeTool[]> {
    const client = await this.connect();
    const { tools } = await client.listTools();
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : {},
    }));
  }

  /** One retry, and only when the transport died: a tool that answered with an error answered. */
  async call(
    mcpName: string,
    args: Record<string, unknown>,
    options: CallOptions = {},
  ): Promise<BridgeCall> {
    try {
      return await this.callOnce(mcpName, args, options);
    } catch (err) {
      if (this.client !== null) throw err;
      this.failure = String(err);
      return this.callOnce(mcpName, args, options);
    }
  }

  private async callOnce(
    mcpName: string,
    args: Record<string, unknown>,
    options: CallOptions,
  ): Promise<BridgeCall> {
    const client = await this.connect();
    const result = await client.callTool({ name: mcpName, arguments: args }, undefined, {
      signal: options.signal,
      timeout: timeoutFor(mcpName, options.timeoutMs),
    });
    return { text: textOf(result), isError: result.isError === true };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.starting = null;
    if (client === null) return;
    client.onclose = undefined;
    try {
      await client.close();
    } catch {
      // A server already gone is a closed server.
    }
  }
}
