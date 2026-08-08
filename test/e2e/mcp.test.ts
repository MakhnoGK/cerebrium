import { EdgeType, MemoryKind } from "@/core/vocab";
import "reflect-metadata";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import {
  CONSOLIDATION_PROVIDER_TOKEN,
  ConsolidationRecommendation,
} from "@/domain/ports/consolidation-provider";
import { EMBEDDING_PROVIDER_TOKEN } from "@/domain/ports/embedding-provider";
import { openDatabase } from "@/db/database";
import { DB_TOKEN } from "@/db/repositories/base";
import { Server } from "@/presentation/mcp/server";
import { sessionIdDescription } from "@/presentation/mcp/tools/contracts";
import { createConsolidator } from "@/consolidation";
import { createProvider } from "@/embeddings";

// Every test gets its own MCP client backed by a fresh in-memory DB, so ordering and
// cross-test state never leak. A child DI container re-binds DB_TOKEN, and the Server
// (with all seventeen tools) is resolved from that scope.
async function connect(): Promise<Client> {
  const scope = container.createChildContainer();
  scope.register(DB_TOKEN, { useValue: openDatabase(":memory:") });
  scope.register(CONSOLIDATION_PROVIDER_TOKEN, { useValue: createConsolidator() });
  scope.register(EMBEDDING_PROVIDER_TOKEN, { useValue: createProvider("local-null") });

  const server = scope.resolve(Server);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return client;
}

interface RawResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

// Parse a successful tool result's JSON payload. Throws (surfacing the tool's error text)
// if the call came back as an MCP error, so a broken tool fails loudly, not silently.
function payload<T = Record<string, unknown>>(res: unknown): T {
  const r = res as RawResult;

  if (r.isError) {
    throw new Error(`tool returned isError: ${r.content[0]?.text ?? "<empty>"}`);
  }

  return JSON.parse(r.content[0]!.text) as T;
}

function asError(res: unknown): { isError: boolean; text: string } {
  const r = res as RawResult;
  return { isError: r.isError === true, text: r.content[0]?.text ?? "" };
}

async function startSession(client: Client, project?: string): Promise<string> {
  const res = payload<{ session_id: string }>(
    await client.callTool({ name: "session_start", arguments: project ? { project } : {} }),
  );
  return res.session_id;
}

interface Envelope {
  id: string;
  kind: string;
  type: string;
  title: string;
  rev?: number;
}

async function writeFact(
  client: Client,
  sid: string,
  title: string,
  content: string,
  project?: string,
): Promise<Envelope & { similar_existing?: { id: string; score: number }[] }> {
  return payload(
    await client.callTool({
      name: "write",
      arguments: {
        session_id: sid,
        memory_kind: "semantic",
        type: "fact",
        title,
        content,
        project,
      },
    }),
  );
}

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/demo-repo");
const UNKNOWN_NODE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const UNKNOWN_CANDIDATE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";

const ALL_TOOLS = [
  "checkpoint",
  "code_index",
  "code_lookup",
  "consolidate_apply",
  "consolidate_suggest",
  "get",
  "invalidate",
  "link",
  "mirror_status",
  "mirror_upsert",
  "restore",
  "search",
  "session_start",
  "source_register",
  "stats",
  "update",
  "write",
];

describe("MCP server wiring", () => {
  it("should expose all seventeen tools when a client connects", async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);
  });

  it("should give every tool a non-trivial description when listed", async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    for (const t of tools) expect(t.description?.length ?? 0).toBeGreaterThan(20);
  });

  it("should advertise a session_id argument when the schema of session_start is inspected", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === "search");

    expect(search?.inputSchema.properties).toHaveProperty("query");
  });

  it("should tell every session-bound tool to copy session_start's exact id", async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    for (const tool of tools.filter((entry) => entry.name !== "session_start")) {
      const session = tool.inputSchema.properties?.session_id as { description?: string };

      expect(session.description, tool.name).toBe(sessionIdDescription);
    }
  });
});

describe("session_start tool", () => {
  it("should return a fresh session_id when called with no arguments", async () => {
    const client = await connect();
    const res = payload<{ session_id: string; hints: string[] }>(
      await client.callTool({ name: "session_start", arguments: {} }),
    );

    expect(res.session_id).toBeTruthy();
    expect(res.hints.length).toBeGreaterThan(0);
  });

  it("should scope the working set to the project when a project is given", async () => {
    const client = await connect();
    const res = payload<{ project: string; working_set: { stats: unknown } }>(
      await client.callTool({ name: "session_start", arguments: { project: "acme" } }),
    );

    expect(res.project).toBe("acme");
    expect(res.working_set).toHaveProperty("stats");
  });

  it("should reject malformed and unknown session ids without creating either", async () => {
    const client = await connect();
    const malformed = asError(
      await client.callTool({
        name: "search",
        arguments: { session_id: "invented", query: "anything" },
      }),
    );
    const unknownId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
    const unknown = asError(
      await client.callTool({
        name: "search",
        arguments: { session_id: unknownId, query: "anything" },
      }),
    );
    const stats = payload<{ content: { sessions: number; nodes_total: number } }>(
      await client.callTool({ name: "stats", arguments: {} }),
    );

    expect(malformed.isError).toBe(true);
    expect(malformed.text).toContain("session_id must be a valid ULID");
    expect(unknown).toStrictEqual({
      isError: true,
      text: expect.stringContaining(`Unknown session_id ${unknownId}`),
    });
    expect(stats.content.sessions).toBe(0);
    expect(stats.content.nodes_total).toBe(0);
  });

  it("should accept the exact id returned by session_start", async () => {
    const client = await connect();
    const sid = await startSession(client);
    const result = payload<{ results: unknown[] }>(
      await client.callTool({
        name: "search",
        arguments: { session_id: sid, query: "anything" },
      }),
    );

    expect(sid).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(result.results).toEqual([]);
  });

  it("should surface prior facts, tasks, and checkpoints when a session resumes", async () => {
    const client = await connect();
    const p = "resume-proj";
    const sid = await startSession(client, p);

    await writeFact(client, sid, "Fact 1", "the sky is blue", p);
    await client.callTool({
      name: "write",
      arguments: {
        session_id: sid,
        memory_kind: "semantic",
        type: "task",
        title: "Task 1",
        content: "ship the thing",
        project: p,
      },
    });
    await client.callTool({
      name: "checkpoint",
      arguments: { session_id: sid, project: p, summary: "left off mid-refactor" },
    });

    const res = payload<{
      working_set: {
        semantic: { title: string }[];
        tasks: { title: string }[];
        checkpoints: { content: string }[];
      };
    }>(await client.callTool({ name: "session_start", arguments: { project: p } }));

    expect(res.working_set.semantic.map((e) => e.title)).toContain("Fact 1");
    expect(res.working_set.tasks.map((e) => e.title)).toContain("Task 1");
    expect(res.working_set.checkpoints[0]!.content).toContain("left off mid-refactor");
  });
});

describe("write tool", () => {
  it("should return an envelope with an id when a semantic fact is written", async () => {
    const client = await connect();
    const sid = await startSession(client);
    const w = await writeFact(client, sid, "Wire", "hello over MCP");

    expect(w.id).toBeTruthy();
    expect(w.kind).toBe("semantic");
    expect(w.type).toBe("fact");
  });

  it("should flag similar_existing when a near-duplicate semantic fact is written", async () => {
    const client = await connect();
    const sid = await startSession(client, "billing");
    const body =
      "Access tokens live fifteen minutes before they expire and then must be refreshed by the client";
    const first = await writeFact(client, sid, "Token TTL", body, "billing");
    const dup = await writeFact(client, sid, "Token TTL", body, "billing");

    expect(dup.similar_existing?.[0]?.id).toBe(first.id);
    expect(dup.similar_existing![0]!.score).toBeGreaterThanOrEqual(0.82);
  });

  it("should stay silent about duplicates when an unrelated fact is written", async () => {
    const client = await connect();
    const sid = await startSession(client, "billing");
    await writeFact(
      client,
      sid,
      "Token TTL",
      "access tokens expire after fifteen minutes",
      "billing",
    );
    const other = await writeFact(
      client,
      sid,
      "Deploy cadence",
      "we ship the mobile app every second Thursday",
      "billing",
    );
    expect(other.similar_existing).toBeUndefined();
  });

  it("should reject the write when memory_kind is mirror", async () => {
    const client = await connect();
    const sid = await startSession(client);
    const res = asError(
      await client.callTool({
        name: "write",
        arguments: {
          session_id: sid,
          memory_kind: "mirror",
          type: "symbol",
          title: "x",
          content: "y",
        },
      }),
    );

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/indexer|code_index/);
  });
});

describe("search tool", () => {
  it("should find a written node when querying its text", async () => {
    const client = await connect();
    const sid = await startSession(client, "srch");
    await writeFact(client, sid, "Alpha", "quokka telemetry pipeline", "srch");
    const res = payload<{ total_matches: number; results: { id: string }[] }>(
      await client.callTool({
        name: "search",
        arguments: { session_id: sid, query: "quokka telemetry", project: "srch" },
      }),
    );

    expect(res.total_matches).toBe(1);
  });

  it("should return zero matches when the query is all punctuation", async () => {
    const client = await connect();
    const sid = await startSession(client);
    const res = payload<{ total_matches: number; results: unknown[] }>(
      await client.callTool({
        name: "search",
        arguments: { session_id: sid, query: "!!! ??? ..." },
      }),
    );

    expect(res.total_matches).toBe(0);
    expect(res.results).toEqual([]);
  });

  it("should not throw when the query contains raw FTS operators", async () => {
    const client = await connect();
    const sid = await startSession(client, "fts");
    await writeFact(client, sid, "T", "alpha beta", "fts");
    const res = payload<{ total_matches: number }>(
      await client.callTool({
        name: "search",
        arguments: { session_id: sid, query: 'alpha AND ) OR * "', project: "fts" },
      }),
    );

    expect(res.total_matches).toBe(1);
  });

  it("should return only semantic results when filtered by kind", async () => {
    const client = await connect();
    const sid = await startSession(client, "kf");
    await writeFact(client, sid, "A", "shared term one", "kf");
    await client.callTool({
      name: "write",
      arguments: {
        session_id: sid,
        memory_kind: "episodic",
        type: "event_note",
        title: "B",
        content: "shared term one",
        project: "kf",
      },
    });
    const res = payload<{ total_matches: number; results: { kind: string }[] }>(
      await client.callTool({
        name: "search",
        arguments: {
          session_id: sid,
          query: "shared",
          kinds: [MemoryKind.SEMANTIC],
          project: "kf",
        },
      }),
    );

    expect(res.total_matches).toBe(1);
    expect(res.results[0]!.kind).toBe("semantic");
  });
});

describe("get tool", () => {
  it("should return full content and edges when fetching by id", async () => {
    const client = await connect();
    const sid = await startSession(client);
    const w = await writeFact(client, sid, "Wire", "hello over MCP");
    const res = payload<{ nodes: { content: string; edges: unknown }[] }>(
      await client.callTool({ name: "get", arguments: { session_id: sid, ids: [w.id] } }),
    );

    expect(res.nodes[0]!.content).toBe("hello over MCP");
    expect(res.nodes[0]).toHaveProperty("edges");
  });

  it("should report not_found when an id is unknown", async () => {
    const client = await connect();
    const sid = await startSession(client);
    const res = payload<{ nodes: unknown[]; not_found: string[] }>(
      await client.callTool({
        name: "get",
        arguments: { session_id: sid, ids: [UNKNOWN_NODE_ID] },
      }),
    );

    expect(res.nodes).toEqual([]);
    expect(res.not_found).toContain(UNKNOWN_NODE_ID);
  });

  it("should include the revision history when include_revisions is set", async () => {
    const client = await connect();
    const sid = await startSession(client);
    const w = await writeFact(client, sid, "Doc", "first body");
    await client.callTool({
      name: "update",
      arguments: { session_id: sid, id: w.id, content: "second body" },
    });
    const res = payload<{ nodes: { revisions: unknown[] }[] }>(
      await client.callTool({
        name: "get",
        arguments: { session_id: sid, ids: [w.id], include_revisions: true },
      }),
    );

    expect(res.nodes[0]!.revisions.length).toBeGreaterThanOrEqual(2);
  });
});

describe("update tool", () => {
  it("should replace the current content when a semantic node is updated", async () => {
    const client = await connect();
    const sid = await startSession(client);
    const w = await writeFact(client, sid, "Fact", "old body");
    await client.callTool({
      name: "update",
      arguments: { session_id: sid, id: w.id, content: "new body", reason: "corrected" },
    });
    const got = payload<{ nodes: { content: string }[] }>(
      await client.callTool({ name: "get", arguments: { session_id: sid, ids: [w.id] } }),
    );

    expect(got.nodes[0]!.content).toBe("new body");
  });

  it("should return an actionable error when the target is an episodic node", async () => {
    const client = await connect();
    const sid = await startSession(client);
    const note = payload<{ id: string }>(
      await client.callTool({
        name: "write",
        arguments: {
          session_id: sid,
          memory_kind: "episodic",
          type: "event_note",
          title: "E",
          content: "x",
        },
      }),
    );
    const res = asError(
      await client.callTool({
        name: "update",
        arguments: { session_id: sid, id: note.id, content: "y" },
      }),
    );

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/write-once/);
  });

  it("should error when neither content nor title is provided", async () => {
    const client = await connect();
    const sid = await startSession(client);
    const w = await writeFact(client, sid, "Fact", "body");
    const res = asError(
      await client.callTool({ name: "update", arguments: { session_id: sid, id: w.id } }),
    );

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/nothing to update/);
  });

  it("should error when the node id does not exist", async () => {
    const client = await connect();
    const sid = await startSession(client);
    const res = asError(
      await client.callTool({
        name: "update",
        arguments: { session_id: sid, id: UNKNOWN_NODE_ID, content: "y" },
      }),
    );

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/does not exist/);
  });
});

describe("invalidate tool", () => {
  it("should soft-delete the node when invalidated", async () => {
    const client = await connect();
    const sid = await startSession(client);
    const w = await writeFact(client, sid, "Gone", "temporary fact");
    const res = payload<{ invalidated: boolean }>(
      await client.callTool({
        name: "invalidate",
        arguments: { session_id: sid, id: w.id, reason: "no longer true" },
      }),
    );

    expect(res.invalidated).toBe(true);
  });

  it("should hide the node from default search but keep it under history:true", async () => {
    const client = await connect();
    const sid = await startSession(client, "inv");
    const w = await writeFact(client, sid, "Retire", "zzxx marker term", "inv");
    await client.callTool({
      name: "invalidate",
      arguments: { session_id: sid, id: w.id, reason: "stale" },
    });

    const normal = payload<{ total_matches: number }>(
      await client.callTool({
        name: "search",
        arguments: { session_id: sid, query: "zzxx marker", project: "inv" },
      }),
    );
    expect(normal.total_matches).toBe(0);

    const hist = payload<{ results: { id: string }[] }>(
      await client.callTool({
        name: "search",
        arguments: { session_id: sid, query: "zzxx marker", project: "inv", history: true },
      }),
    );
    expect(hist.results.some((r) => r.id === w.id)).toBe(true);
  });

  it("should error when the node id is unknown", async () => {
    const client = await connect();
    const sid = await startSession(client);
    const res = asError(
      await client.callTool({
        name: "invalidate",
        arguments: { session_id: sid, id: UNKNOWN_NODE_ID, reason: "x" },
      }),
    );
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/does not exist/);
  });
});

describe("link tool", () => {
  it("should create an edge when two existing nodes are linked", async () => {
    const client = await connect();
    const sid = await startSession(client);
    const a = await writeFact(client, sid, "A", "first node");
    const b = await writeFact(client, sid, "B", "second node");
    const res = payload<{ ok: boolean; type: string }>(
      await client.callTool({
        name: "link",
        arguments: { session_id: sid, src: a.id, dst: b.id, type: EdgeType.REFERENCES },
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.type).toBe("references");
  });

  it("should reject a self-link when src equals dst", async () => {
    const client = await connect();
    const sid = await startSession(client);
    const a = await writeFact(client, sid, "A", "node");
    const res = asError(
      await client.callTool({
        name: "link",
        arguments: { session_id: sid, src: a.id, dst: a.id, type: EdgeType.REFERENCES },
      }),
    );
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/itself/);
  });

  it("should error when the destination node does not exist", async () => {
    const client = await connect();
    const sid = await startSession(client);
    const a = await writeFact(client, sid, "A", "node");
    const res = asError(
      await client.callTool({
        name: "link",
        arguments: {
          session_id: sid,
          src: a.id,
          dst: UNKNOWN_NODE_ID,
          type: EdgeType.REFERENCES,
        },
      }),
    );
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/does not exist/);
  });
});

describe("checkpoint tool", () => {
  it("should write a checkpoint envelope when called with a summary", async () => {
    const client = await connect();
    const sid = await startSession(client, "cp");
    const res = payload<Envelope>(
      await client.callTool({
        name: "checkpoint",
        arguments: {
          session_id: sid,
          project: "cp",
          summary: "wrapped up the parser",
          decisions: ["use RRF"],
          open_threads: ["wire the reranker"],
        },
      }),
    );
    expect(res.id).toBeTruthy();
    expect(res.type).toBe("checkpoint");
    expect(res.kind).toBe("episodic");
  });

  it("should render Summary/Decisions sections when the checkpoint is fetched back", async () => {
    const client = await connect();
    const sid = await startSession(client, "cp");
    const cp = payload<{ id: string }>(
      await client.callTool({
        name: "checkpoint",
        arguments: {
          session_id: sid,
          project: "cp",
          summary: "did things",
          decisions: ["chose X"],
        },
      }),
    );

    const got = payload<{ nodes: { content: string }[] }>(
      await client.callTool({ name: "get", arguments: { session_id: sid, ids: [cp.id] } }),
    );

    expect(got.nodes[0]!.content).toContain("## Summary");
    expect(got.nodes[0]!.content).toContain("chose X");
  });

  it("should note ignored ids when touched_node_ids include unknown nodes", async () => {
    const client = await connect();
    const sid = await startSession(client, "cp");
    const res = payload<{ hints?: string[] }>(
      await client.callTool({
        name: "checkpoint",
        arguments: {
          session_id: sid,
          project: "cp",
          summary: "s",
          touched_node_ids: [UNKNOWN_NODE_ID],
        },
      }),
    );
    expect((res.hints ?? []).some((h) => /Ignored .*unknown/.test(h))).toBe(true);
  });
});

describe("stats tool", () => {
  it("should report queue, content, and drain sections when called", async () => {
    const client = await connect();
    const sid = await startSession(client);
    await writeFact(client, sid, "x", "a durable fact with a body of words");
    const res = payload<{
      queue: { backlog: number };
      content: { nodes_total: number };
      drain: { provider: string; daemon_alive: boolean };
      rerank: { provider: string; enabled: boolean };
    }>(await client.callTool({ name: "stats", arguments: { session_id: sid } }));

    expect(res.queue.backlog).toBe(1);
    expect(res.content.nodes_total).toBe(1);
    expect(res.drain.provider).toBe("local-null@1");
    expect(res.drain).toHaveProperty("daemon_alive");
  });

  it("should work without a session_id when peeked read-only", async () => {
    const client = await connect();
    const res = payload<{ queue: { total: number } }>(
      await client.callTool({ name: "stats", arguments: {} }),
    );
    expect(res.queue.total).toBe(0);
  });
});

describe("source_register tool", () => {
  it("should return the stored source when a source is registered", async () => {
    const client = await connect();
    const sid = await startSession(client, "acme");
    const res = payload<{ source: { id: string; kind: string } }>(
      await client.callTool({
        name: "source_register",
        arguments: {
          session_id: sid,
          id: "grafana-prod",
          kind: "grafana",
          label: "Grafana (prod)",
          project: "acme",
          freshness_hours: 24,
        },
      }),
    );
    expect(res.source.id).toBe("grafana-prod");
    expect(res.source.kind).toBe("grafana");
  });

  it("should update the source in place when the same id is re-registered", async () => {
    const client = await connect();
    const sid = await startSession(client, "acme");
    const reg = () =>
      client.callTool({
        name: "source_register",
        arguments: { session_id: sid, id: "sentry", kind: "sentry", project: "acme" },
      });
    await reg();
    payload(await reg());
    const status = payload<{ sources: { id: string }[] }>(
      await client.callTool({ name: "mirror_status", arguments: { session_id: sid } }),
    );
    expect(status.sources.filter((s) => s.id === "sentry")).toHaveLength(1);
  });
});

describe("mirror_status tool", () => {
  it("should return an empty list when no sources are registered", async () => {
    const client = await connect();
    const sid = await startSession(client, "acme");
    const res = payload<{ sources: unknown[] }>(
      await client.callTool({ name: "mirror_status", arguments: { session_id: sid } }),
    );
    expect(res.sources).toEqual([]);
  });

  it("should report a source as stale when it has never been synced", async () => {
    const client = await connect();
    const sid = await startSession(client, "acme");
    await client.callTool({
      name: "source_register",
      arguments: { session_id: sid, id: "grafana-prod", kind: "grafana", freshness_hours: 24 },
    });
    const res = payload<{ sources: { id: string; stale: boolean; node_count: number }[] }>(
      await client.callTool({ name: "mirror_status", arguments: { session_id: sid } }),
    );
    expect(res.sources).toHaveLength(1);
    expect(res.sources[0]).toMatchObject({ id: "grafana-prod", stale: true, node_count: 0 });
  });
});

describe("mirror_upsert tool", () => {
  const INCIDENT = {
    native_id: "INC-42",
    type: "incident",
    title: "Checkout latency spike",
    content: "p99 checkout latency crossed 2s for 12 minutes; rolled back deploy #918.",
    url: "https://grafana/incident/42",
    facets: { severity: "sev2" },
  };

  async function registerGrafana(client: Client, sid: string, enabled = true): Promise<void> {
    await client.callTool({
      name: "source_register",
      arguments: {
        session_id: sid,
        id: "grafana-prod",
        kind: "grafana",
        project: "acme",
        freshness_hours: 24,
        enabled,
      },
    });
  }

  it("should mirror a curated record and bump the source out of staleness when the source is registered", async () => {
    const client = await connect();
    const sid = await startSession(client, "acme");
    await registerGrafana(client, sid);

    const up = payload<{ added: number; node_ids: string[] }>(
      await client.callTool({
        name: "mirror_upsert",
        arguments: { session_id: sid, source_id: "grafana-prod", items: [INCIDENT] },
      }),
    );
    expect(up.added).toBe(1);

    const got = payload<{
      nodes: { url?: string; facets?: unknown; mirror?: { source_id: string } }[];
    }>(
      await client.callTool({
        name: "get",
        arguments: { session_id: sid, ids: [up.node_ids[0]!] },
      }),
    );
    expect(got.nodes[0]!.url).toBe(INCIDENT.url);
    expect(got.nodes[0]!.facets).toEqual(INCIDENT.facets);
    expect(got.nodes[0]!.mirror?.source_id).toBe("grafana-prod");

    const status = payload<{ sources: { stale: boolean; node_count: number }[] }>(
      await client.callTool({ name: "mirror_status", arguments: { session_id: sid } }),
    );
    expect(status.sources[0]).toMatchObject({ stale: false, node_count: 1 });
  });

  it("should treat a re-synced identical record as unchanged when upserted twice", async () => {
    const client = await connect();
    const sid = await startSession(client, "acme");
    await registerGrafana(client, sid);
    const args = { session_id: sid, source_id: "grafana-prod", items: [INCIDENT] };
    await client.callTool({ name: "mirror_upsert", arguments: args });
    const again = payload<{ added: number; unchanged: number }>(
      await client.callTool({ name: "mirror_upsert", arguments: args }),
    );
    expect(again.added).toBe(0);
    expect(again.unchanged).toBe(1);
  });

  it("should error actionably when the source is not registered", async () => {
    const client = await connect();
    const sid = await startSession(client, "acme");
    const res = asError(
      await client.callTool({
        name: "mirror_upsert",
        arguments: { session_id: sid, source_id: "nope", items: [INCIDENT] },
      }),
    );
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/source_register/);
  });

  it("should error when the source is registered but disabled", async () => {
    const client = await connect();
    const sid = await startSession(client, "acme");
    await registerGrafana(client, sid, false);
    const res = asError(
      await client.callTool({
        name: "mirror_upsert",
        arguments: { session_id: sid, source_id: "grafana-prod", items: [INCIDENT] },
      }),
    );
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/disabled/);
  });
});

describe("code_index tool", () => {
  it("should return a compact summary when indexing an explicit path", async () => {
    const client = await connect();
    const sid = await startSession(client);

    const res = payload<{ repo: string; files_indexed: number; symbols_added: number }>(
      await client.callTool({ name: "code_index", arguments: { session_id: sid, path: FIXTURE } }),
    );

    expect(res.repo).toBe("demo-repo");
    expect(res.files_indexed).toBe(2);
    expect(res.symbols_added).toBeGreaterThan(4);
    expect(res).not.toHaveProperty("symbols");
  });

  it("should error when the repo is unknown and no path is given", async () => {
    const client = await connect();
    const sid = await startSession(client);

    const res = asError(
      await client.callTool({ name: "code_index", arguments: { session_id: sid, repo: "nope" } }),
    );

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not configured/);
  });
});

describe("code_lookup tool", () => {
  async function indexed(client: Client): Promise<string> {
    const sid = await startSession(client);
    await client.callTool({ name: "code_index", arguments: { session_id: sid, path: FIXTURE } });
    return sid;
  }

  it("should resolve a symbol by name with neighbor stubs when indexed", async () => {
    const client = await connect();
    const sid = await indexed(client);
    const res = payload<{
      symbols: { symbol_kind: string; neighbors: { edge: string; title: string }[] }[];
    }>(
      await client.callTool({
        name: "code_lookup",
        arguments: { session_id: sid, name: "AuthService" },
      }),
    );
    expect(res.symbols).toHaveLength(1);
    expect(res.symbols[0]!.symbol_kind).toBe("class");
    expect(
      res.symbols[0]!.neighbors.some((n) => n.edge === "defines" && n.title.endsWith("validate")),
    ).toBe(true);
  });

  it("should list a file's symbols when given a file path", async () => {
    const client = await connect();
    const sid = await indexed(client);
    const res = payload<{ symbols: { symbol_kind: string }[] }>(
      await client.callTool({
        name: "code_lookup",
        arguments: { session_id: sid, file: "util/crypto.ts" },
      }),
    );
    const kinds = res.symbols.map((s) => s.symbol_kind);
    expect(kinds).toContain("function");
    expect(kinds).toContain("enum");
  });

  it("should error when neither name nor file is provided", async () => {
    const client = await connect();
    const sid = await indexed(client);
    const res = asError(
      await client.callTool({ name: "code_lookup", arguments: { session_id: sid } }),
    );
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/provide/);
  });

  it("should return the raw source slice and facets when a symbol is fetched via get", async () => {
    const client = await connect();
    const sid = await indexed(client);
    const looked = payload<{ symbols: { id: string }[] }>(
      await client.callTool({
        name: "code_lookup",
        arguments: { session_id: sid, name: "AuthService" },
      }),
    );
    const res = payload<{ nodes: { source: string; symbol: { symbol_kind: string } }[] }>(
      await client.callTool({
        name: "get",
        arguments: { session_id: sid, ids: [looked.symbols[0]!.id] },
      }),
    );
    expect(res.nodes[0]!.source).toContain("class AuthService");
    expect(res.nodes[0]!.symbol.symbol_kind).toBe("class");
  });
});

describe("consolidate_suggest / consolidate_apply tools", () => {
  it("should return an empty candidate list when nothing is queued", async () => {
    const client = await connect();
    const sid = await startSession(client);
    const res = payload<{ candidates: unknown[] }>(
      await client.callTool({ name: "consolidate_suggest", arguments: { session_id: sid } }),
    );
    expect(res.candidates).toEqual([]);
  });

  it("should error when applying an unknown candidate id", async () => {
    // Given
    const client = await connect();
    const sid = await startSession(client);

    // When
    const res = asError(
      await client.callTool({
        name: "consolidate_apply",
        arguments: {
          session_id: sid,
          id: UNKNOWN_CANDIDATE_ID,
          decision: ConsolidationRecommendation.APPLY,
        },
      }),
    );

    // Then
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/no consolidation candidate/);
  });
});
