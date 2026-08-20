import { container, type InjectionToken } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { CallPipeline } from "@/application/call-pipeline";
import { FETCH_NODES, LOOKUP_CODE, SEARCH_MEMORY } from "@/application/use-cases";
import { MemoryKind } from "@/core/vocab";
import { CodeLookupTool } from "@/presentation/mcp/tools/code-lookup";
import { GetTool } from "@/presentation/mcp/tools/get";
import { SearchTool } from "@/presentation/mcp/tools/search";
import { setup, type TestEnv } from "@test/helpers";

// The retrieval-outcome log is what `report:readloop`, the gold set and every calibration
// run are computed from. It went blind for reads the moment the host became a proxy: the
// tool that produced the detail stayed on the host while the row was written across the
// socket, and a read carried no session to attribute it to. Nothing failed, and nothing
// said so. These assert the shape the report actually joins on.

let env: TestEnv;
let pipeline: CallPipeline;
let session: string;

async function seed(title: string, content: string): Promise<string> {
  const written = (await pipeline.invoke(container, "write_memory", {
    session_id: session,
    parent_node_id: null,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title,
    content,
  })) as { envelope: { id: string } };

  return written.envelope.id;
}

function rows(action: string): { detail: Record<string, unknown>; node_id: string | null }[] {
  return (
    env.db
      .prepare("SELECT node_id, detail FROM events WHERE action = ? AND session_id = ?")
      .all(action, session) as { node_id: string | null; detail: string | null }[]
  ).map((row) => ({
    node_id: row.node_id,
    detail: (row.detail === null ? {} : JSON.parse(row.detail)) as Record<string, unknown>,
  }));
}

beforeEach(async () => {
  env = setup();
  pipeline = container.resolve(CallPipeline);
  const started = (await pipeline.invoke(container, "start_session", {})) as {
    session_id: string;
  };
  session = started.session_id;
});

describe("Retrieval-outcome log", () => {
  it("should attribute a search to the session that ran it", async () => {
    // Given
    await seed("Retry budget", "the http client retries with exponential backoff");
    await env.worker.tick();

    // When
    await pipeline.invoke(container, "search_memory", {
      session_id: session,
      query: "http client retries",
      limit: 5,
      mode: "text",
    });

    // Then — an unattributed read is not logged at all, so this is the whole difference
    // between having the log and not having it.
    expect(rows("search")).toHaveLength(1);
  });

  it("should record which ids a search surfaced and how each matched", async () => {
    // Given
    const id = await seed("Retry budget", "the http client retries with exponential backoff");
    await env.worker.tick();

    // When
    await pipeline.invoke(container, "search_memory", {
      session_id: session,
      query: "http client retries",
      limit: 5,
      mode: "text",
    });

    // Then
    const [logged] = rows("search");

    expect(logged!.detail.ids).toContain(id);
    expect(logged!.detail.matched).toEqual(["text"]);
    expect(logged!.detail.mode).toBe("text");
  });

  it("should record what a fetch asked for and how much of it resolved", async () => {
    // Given
    const id = await seed("Retry budget", "the http client retries with exponential backoff");
    const missing = "01JJJJJJJJJJJJJJJJJJJJJJJJ";

    // When
    await pipeline.invoke(container, "fetch_nodes", { session_id: session, ids: [id, missing] });

    // Then — these ids are what a preceding search's ids are joined against.
    const [logged] = rows("get");

    expect(logged!.detail).toMatchObject({ ids: [id, missing], found: 1, not_found: [missing] });
  });

  it("should keep an outline distinguishable from a read", async () => {
    // Given — an outline is a decision aid, and counting it as a read would read as
    // evidence the agent found the node worth its tokens.
    const id = await seed("Retry budget", "the http client retries with exponential backoff");

    // When
    await pipeline.invoke(container, "fetch_nodes", {
      session_id: session,
      ids: [id],
      outline: true,
    });

    // Then
    expect(rows("get")[0]!.detail.outline).toBe(true);
  });

  it("should name the sections a narrowed fetch actually read", async () => {
    // Given
    const id = await seed(
      "Retry budget",
      "## Policy\nthe http client retries with exponential backoff\n\n## Limits\nfive attempts",
    );

    // When
    await pipeline.invoke(container, "fetch_nodes", {
      session_id: session,
      ids: [id],
      sections: ["H2: Policy"],
    });

    // Then — a finer label than the node id, which is what a chunk-level signal needs.
    expect(rows("get")[0]!.detail.sections).toEqual(["H2: Policy"]);
  });

  it("should still record the node a write produced", async () => {
    // Given / When
    const id = await seed("Retry budget", "the http client retries with exponential backoff");

    // Then
    expect(rows("write").map((r) => r.node_id)).toContain(id);
  });
});

// A read carries no session of its own: the tool is handed one and has to pass it down, or
// the daemon writing the row on the far side of the socket has nothing to attribute it to.
// That is exactly how the log went blind, and it is invisible from either side alone.
describe("Session travelling from tool to use case", () => {
  function spy(token: InjectionToken<unknown>, result: unknown) {
    const scope = container.createChildContainer();
    const calls: Record<string, unknown>[] = [];

    scope.register(token, {
      useValue: {
        invoke(args: Record<string, unknown>) {
          calls.push(args);

          return Promise.resolve(result);
        },
      },
    });

    return { scope, calls };
  }

  it("should hand the session to the search use case", async () => {
    // Given
    const { scope, calls } = spy(SEARCH_MEMORY, {
      results: [],
      total_matches: 0,
      notes: [],
      audit: { mode: "text", query: "q", results: 0, ids: [], matched: [], folded: [] },
    });

    // When
    await scope.resolve(SearchTool).invoke({ session_id: session, query: "q", limit: 5 });

    // Then
    expect(calls[0]!.session_id).toBe(session);
  });

  it("should hand the session to the fetch use case", async () => {
    // Given
    const { scope, calls } = spy(FETCH_NODES, { nodes: [], not_found: [], used: [] });

    // When
    await scope
      .resolve(GetTool)
      .invoke({ session_id: session, ids: ["01JJJJJJJJJJJJJJJJJJJJJJJJ"] });

    // Then
    expect(calls[0]!.session_id).toBe(session);
  });

  it("should hand the session to the code lookup use case", async () => {
    // Given
    const { scope, calls } = spy(LOOKUP_CODE, { symbols: [] });

    // When
    await scope
      .resolve(CodeLookupTool)
      .invoke({ session_id: session, name: "AuthService", limit: 5 });

    // Then
    expect(calls[0]!.session_id).toBe(session);
  });
});
