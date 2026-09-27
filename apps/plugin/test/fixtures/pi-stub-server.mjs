// A minimal MCP server over stdio, so the pi bridge can be tested for what it owns —
// spawning, listing, calling, env passing and reconnecting — without a database.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const TOOLS = [
  {
    name: "session_start",
    description: "Open a session. Returns an id.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { project: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description: "Echo the arguments back. First sentence. Second sentence.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        session_id: { type: "string", pattern: "^[0-7][0-9A-HJKMNP-TV-Z]{25}$" },
        query: { type: "string" },
      },
      required: ["session_id", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "boom",
    description: "Always answers with an error.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "die",
    description: "Kills the server process.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const server = new Server({ name: "pi-stub", version: "1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name === "die") {
    setTimeout(() => process.exit(0), 5);
    return { content: [{ type: "text", text: "{}" }] };
  }
  if (name === "boom") {
    return { content: [{ type: "text", text: "stub failure" }], isError: true };
  }
  if (name === "session_start") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            session_id: "01M0Y9C8Y8HPM5BKY6SDNMDYJS",
            project: args.project ?? null,
            working_set: { tasks: [{ id: "01AAA", title: "stub task" }], checkpoints: [] },
          }),
        },
      ],
    };
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          echoed: args,
          label: process.env.STUB_LABEL ?? null,
          results: [{ id: "01BBB", title: "stub hit" }],
          total_matches: 1,
        }),
      },
    ],
  };
});

await server.connect(new StdioServerTransport());
