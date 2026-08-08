import { createHash } from "node:crypto";
import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { EmbeddingRole } from "@/domain/ports/embedding-provider";
import type { Envelope, ExtractedSymbol, FileIndexInput } from "@/db/repo";
import { MemoryKind, SYMBOL_TYPE } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup, TestEnv } from "@test/helpers";

const REPO = "demo";
const PATH = "auth/auth.service.ts";
const TS = "2026-01-01T00:00:00.000Z";

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 24);
}

function sym(name: string, source: string): ExtractedSymbol {
  const qualified = `${PATH}:${name}`;
  return {
    external_id: hash(`${REPO}\0${PATH}\0${qualified}\0function`),
    symbol_kind: "function",
    name,
    qualified,
    signature: `function ${name}()`,
    summary: `function ${name}() indexed from the demo repository`,
    start_line: 1,
    end_line: 2,
    code_hash: hash(source),
    source,
  };
}

function fileInput(symbols: ExtractedSymbol[]): FileIndexInput {
  return {
    repo: REPO,
    path: PATH,
    lang: "typescript",
    fileHash: hash(symbols.map((s) => s.source).join("|")),
    defines: [],
    session_id: "sess-1",
    ts: TS,
    symbols,
  };
}

async function session(): Promise<string> {
  return (await container.resolve(SessionStartTool).invoke({})).session_id;
}

async function writeFact(s: string, title: string): Promise<Envelope> {
  return container.resolve(WriteTool).invoke({
    session_id: s,
    parent_node_id: null,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title,
    content: `a durable fact about ${title} with a few words of body text`,
  });
}

function mirrorRecord(env: TestEnv, session_id: string): string {
  const source = env.mirror.registerSource({ id: "jira", kind: "jira", label: "Jira", ts: TS });
  const res = env.mirror.upsertMirrors(
    source,
    [
      {
        native_id: "AB-1",
        type: "issue",
        title: "AB-1 payment retries",
        content: "the retry ladder for failed payments, decided in the payments sync",
      },
    ],
    session_id,
    TS,
  );
  return res.node_ids[0]!;
}

function symbolNodeIds(env: TestEnv): string[] {
  return (env.db.prepare("SELECT node_id FROM symbols").all() as { node_id: string }[]).map(
    (r) => r.node_id,
  );
}

function poolCount(env: TestEnv, pool: "chunk_vec" | "code_vec"): number {
  return (env.db.prepare(`SELECT COUNT(*) AS c FROM ${pool}`).get() as { c: number }).c;
}

// Drains everything the write and index paths enqueued, so both pools are populated.
async function drain(env: TestEnv): Promise<void> {
  for (let i = 0; i < 200 && env.queue.embeddingStats().backlog > 0; i++) {
    await env.worker.tick();
  }
}

async function query(env: TestEnv, text: string): Promise<number[]> {
  const [vec] = await env.provider.embed([text], EmbeddingRole.QUERY);
  return vec!;
}

describe("Vector pool routing", () => {
  it("should send a code symbol to code_vec and authored memory to chunk_vec when both are embedded", async () => {
    // Given
    const env = setup();
    const s = await session();
    await writeFact(s, "Retention policy");
    env.code.applyFileIndex(fileInput([sym("validate", "function validate() {}")]));

    // When
    await drain(env);

    // Then
    expect(poolCount(env, "code_vec")).toBeGreaterThan(0);
    expect(poolCount(env, "chunk_vec")).toBeGreaterThan(0);
    const misplaced = env.db
      .prepare(
        `SELECT COUNT(*) AS c FROM code_vec v
         JOIN chunks c ON c.id = v.chunk_id JOIN nodes n ON n.id = c.node_id
         WHERE n.origin IS NOT 'repo'`,
      )
      .get() as { c: number };
    expect(misplaced.c).toBe(0);
  });

  it("should keep a curated external mirror in chunk_vec when it is embedded", async () => {
    // Given
    const env = setup();
    const s = await session();
    const id = mirrorRecord(env, s);

    // When
    await drain(env);

    // Then
    const inAuthored = env.db
      .prepare(
        `SELECT COUNT(*) AS c FROM chunk_vec v JOIN chunks c ON c.id = v.chunk_id
         WHERE c.node_id = ?`,
      )
      .get(id) as { c: number };
    expect(inAuthored.c).toBeGreaterThan(0);
    expect(poolCount(env, "code_vec")).toBe(0);
  });

  it("should return the same authored candidates however much code is indexed", async () => {
    // Given
    const env = setup();
    const s = await session();
    for (const t of ["Retention", "Backoff", "Sharding", "Quotas", "Failover"]) {
      await writeFact(s, t);
    }
    await drain(env);
    const opts = {
      kinds: [MemoryKind.SEMANTIC, MemoryKind.EPISODIC],
      history: false,
      cap: 50,
    };
    const q = await query(env, "retention policy");
    const before = env.search.vectorSearch(q, opts).map((r) => r.id);
    expect(before.length).toBe(5);

    // When — three times VEC_K worth of code arrives, which in one shared pool would
    // have displaced most of these five from the k=200 over-fetch.
    env.code.applyFileIndex(
      fileInput(Array.from({ length: 600 }, (_, i) => sym(`fn${i}`, `function fn${i}() {}`))),
    );
    await drain(env);

    // Then
    expect(env.search.vectorSearch(q, opts).map((r) => r.id)).toEqual(before);
  });

  it("should still reach code symbols when the query asks for them by type", async () => {
    // Given
    const env = setup();
    const s = await session();
    await writeFact(s, "Retention policy");
    env.code.applyFileIndex(fileInput([sym("validate", "function validate() {}")]));
    await drain(env);

    // When
    const rows = env.search.vectorSearch(await query(env, "validate"), {
      types: [SYMBOL_TYPE],
      history: false,
      cap: 50,
    });

    // Then
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.type === SYMBOL_TYPE)).toBe(true);
  });

  it("should return hits from both pools when the query filters neither kind nor type", async () => {
    // Given
    const env = setup();
    const s = await session();
    await writeFact(s, "Retention policy");
    env.code.applyFileIndex(fileInput([sym("validate", "function validate() {}")]));
    await drain(env);

    // When
    const kinds = new Set(
      env.search
        .vectorSearch(await query(env, "retention"), { history: false, cap: 50 })
        .map((r) => r.memory_kind),
    );

    // Then
    expect(kinds.has(MemoryKind.MIRROR)).toBe(true);
    expect(kinds.has(MemoryKind.SEMANTIC)).toBe(true);
  });

  it("should make every live authored node a candidate when the authored pool fits under k", async () => {
    // Given
    const env = setup();
    const s = await session();
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push((await writeFact(s, `Fact ${i}`)).id);
    await drain(env);

    // When
    const rows = env.search.vectorSearch(await query(env, "anything at all"), {
      kinds: [MemoryKind.SEMANTIC],
      history: false,
      cap: 100,
    });

    // Then
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(ids));
  });

  it("should resolve MMR vectors for nodes from either pool", async () => {
    // Given
    const env = setup();
    const s = await session();
    const fact = await writeFact(s, "Retention policy");
    env.code.applyFileIndex(fileInput([sym("validate", "function validate() {}")]));
    await drain(env);
    const symbols = symbolNodeIds(env);

    // When
    const vectors = env.search.vectorsFor([fact.id, ...symbols]);

    // Then
    expect(vectors.has(fact.id)).toBe(true);
    for (const id of symbols) expect(vectors.has(id)).toBe(true);
  });
});
