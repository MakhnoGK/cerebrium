import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { CallPipeline, UnknownCallError } from "@/application/call-pipeline";
import {
  CALL_SURFACE,
  callKind,
  isCallName,
  isRetryable,
  READ_SURFACE,
  type CallName,
} from "@/application/use-cases";
import { MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { setup, type TestEnv } from "@test/helpers";

let env: TestEnv;
let session: string;
let pipeline: CallPipeline;

function events(): { action: string; session_id: string; node_id: string | null }[] {
  return env.db.prepare("SELECT action, session_id, node_id FROM events ORDER BY ts, id").all() as {
    action: string;
    session_id: string;
    node_id: string | null;
  }[];
}

function useCount(id: string): number {
  const row = env.db.prepare("SELECT use_count FROM nodes WHERE id = ?").get(id) as {
    use_count: number;
  };

  return row.use_count;
}

const write = (title: string): Record<string, unknown> => ({
  session_id: session,
  parent_node_id: null,
  memory_kind: MemoryKind.SEMANTIC,
  type: "fact",
  title,
  content: "a fact with enough words in it to make a chunk worth embedding",
});

beforeEach(async () => {
  env = setup();
  session = (await container.resolve(SessionStartTool).invoke({})).session_id;
  pipeline = container.resolve(CallPipeline);
});

describe("Call surface classification", () => {
  it("should classify every write as non-retryable and every read as retryable", () => {
    // Given / When / Then — a client that timed out must know which calls it may repeat.
    for (const name of Object.keys(CALL_SURFACE) as CallName[]) {
      expect(isRetryable(name)).toBe(callKind(name) === "read");
    }
  });

  it("should keep the writes that create or resolve things out of the retryable set", () => {
    // Given / When / Then
    for (const name of ["write_memory", "apply_candidate", "record_checkpoint", "link_nodes"]) {
      expect(isRetryable(name as CallName)).toBe(false);
    }
  });

  it("should send every read on the surface to the read pool", () => {
    // Given — a read absent from READ_SURFACE would quietly run on the main thread,
    // defeating the pool for that call.
    const reads = (Object.keys(CALL_SURFACE) as CallName[]).filter((n) => callKind(n) === "read");

    // When / Then
    for (const name of reads) {
      expect(Object.hasOwn(READ_SURFACE, name)).toBe(true);
    }
  });

  it("should exclude the pipeline's own machinery from the callable surface", () => {
    // Given / When / Then — these are what happens around a call, not calls. `session_hints`
    // is on the surface, because tools call it themselves and a remote host must be able to.
    expect(isCallName("touch_session")).toBe(false);
    expect(isCallName("record_events")).toBe(false);
    expect(isCallName("session_hints")).toBe(true);
  });

  it("should treat session_hints as a write, because it touches the session", () => {
    // Given / When / Then — it reads like a lookup, but requireSession updates last_seen,
    // so routing it to a read-only worker would fail at runtime.
    expect(callKind("session_hints")).toBe("write");
    expect(isRetryable("session_hints")).toBe(false);
  });

  it("should refuse a name it does not know", () => {
    // Given / When / Then
    expect(isCallName("drop_everything")).toBe(false);
    expect(isCallName("__proto__")).toBe(false);
  });
});

describe("Call pipeline invariants", () => {
  it("should append an events row for a successful call", async () => {
    // Given / When
    const result = (await pipeline.invoke(container, "write_memory", write("Retry budget"))) as {
      envelope: { id: string };
    };

    // Then — the node id is what the read-loop report joins on, and write_memory answers
    // {envelope:{id}} rather than {id}.
    const audit = events().filter((e) => e.action === "write");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.session_id).toBe(session);
    expect(audit[0]!.node_id).toBe(result.envelope.id);
  });

  it("should append an events row when a call fails, then rethrow", async () => {
    // Given / When
    await expect(
      pipeline.invoke(container, "invalidate_memory", {
        session_id: session,
        id: "01JJJJJJJJJJJJJJJJJJJJJJJJ",
      }),
    ).rejects.toThrow();

    // Then — a failed call is still provenance.
    expect(events().filter((e) => e.action === "invalidate")).toHaveLength(1);
  });

  it("should reject an unknown session before the call runs, not after", async () => {
    // Given
    const before = env.db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number };

    // When
    await expect(
      pipeline.invoke(container, "write_memory", {
        ...write("Should not exist"),
        session_id: "01JJJJJJJJJJJJJJJJJJJJJJJJ",
      }),
    ).rejects.toThrow();

    // Then — nothing was written.
    const after = env.db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it("should refuse a call that is not on the surface", async () => {
    // Given / When / Then
    await expect(pipeline.invoke(container, "sudo_delete", {})).rejects.toBeInstanceOf(
      UnknownCallError,
    );
  });

  it("should route a read to the dispatcher and a write in-process", async () => {
    // Given
    const dispatched: string[] = [];
    pipeline.useReadDispatcher((name, args) => {
      dispatched.push(name);

      return Promise.resolve({ routed: true, args });
    });

    // When
    const read = (await pipeline.invoke(container, "search_memory", {
      session_id: session,
      query: "anything",
      limit: 5,
    })) as { routed?: boolean };
    await pipeline.invoke(container, "write_memory", write("Written locally"));

    // Then
    expect(read.routed).toBe(true);
    expect(dispatched).toEqual(["search_memory"]);
  });

  it("should still audit a read that was dispatched elsewhere", async () => {
    // Given
    pipeline.useReadDispatcher(() => Promise.resolve({ results: [] }));

    // When
    await pipeline.invoke(container, "search_memory", {
      session_id: session,
      query: "anything",
      limit: 5,
    });

    // Then — provenance must not depend on which thread served the call.
    expect(events().filter((e) => e.action === "search")).toHaveLength(1);
  });

  it("should record the use a dispatched `get` could not write itself", async () => {
    // Given — a read worker holds a read-only handle, so the bump that `get` owes its
    // nodes has to happen on this side of the dispatch or not at all.
    const written = (await pipeline.invoke(container, "write_memory", write("Fetched later"))) as {
      envelope: { id: string };
    };
    const id = written.envelope.id;
    pipeline.useReadDispatcher((_name, args) =>
      Promise.resolve({ nodes: [{ id }], not_found: [], used: (args as { ids: string[] }).ids }),
    );

    // When
    await pipeline.invoke(container, "fetch_nodes", { session_id: session, ids: [id] });

    // Then
    expect(useCount(id)).toBe(1);
  });

  it("should not double-count a `get` that ran in-process", async () => {
    // Given — no dispatcher, so the use case runs here and records the use itself.
    const written = (await pipeline.invoke(container, "write_memory", write("Fetched here"))) as {
      envelope: { id: string };
    };
    const id = written.envelope.id;

    // When
    await pipeline.invoke(container, "fetch_nodes", { session_id: session, ids: [id] });

    // Then
    expect(useCount(id)).toBe(1);
  });

  it("should log nothing for a call that carries no session to attribute it to", async () => {
    // Given — events.session_id is NOT NULL, so an unattributable call logs nothing rather
    // than inventing an attribution.
    const before = events().length;

    // When
    await pipeline.invoke(container, "suggest_candidates", {});

    // Then
    expect(events()).toHaveLength(before);
  });

  it("should stamp the writer from the transport over anything the caller claims", async () => {
    // Given — the caller names itself in its arguments, which is what a model driving the
    // tool could reach.
    const forged = { project: null, client: { client: "totally-trusted", version: "9" } };

    // When
    const { session_id } = (await pipeline.invoke(container, "start_session", forged, {
      client: "claude-code",
      version: "2.1.224",
    })) as { session_id: string };

    // Then
    expect(
      env.db.prepare("SELECT client, client_version FROM sessions WHERE id = ?").get(session_id),
    ).toEqual({ client: "claude-code", client_version: "2.1.224" });
  });

  it("should attribute the session-start row to the session it just minted", async () => {
    // Given / When — the id is in the result, not the arguments, so the audit row would
    // otherwise have nothing to attach to.
    const { session_id } = (await pipeline.invoke(container, "start_session", {})) as {
      session_id: string;
    };

    // Then
    expect(
      events().filter((e) => e.action === "session_start" && e.session_id === session_id),
    ).toHaveLength(1);
  });
});
