import { gzipSync } from "node:zlib";
import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex, type CodeContext } from "@cerebrium/contracts/code";
import { EdgeType, MemoryKind } from "@cerebrium/contracts/vocab";
import { CODE_PARSER_TOKEN } from "@/domain/ports/code-parser";
import { CallPipeline } from "@/application/call-pipeline";
import {
  CODE_COMMIT,
  CODE_MANIFEST,
  CODE_UPLOAD,
  FETCH_NODES,
  LINK_NODES,
  LOOKUP_CODE,
  SEARCH_MEMORY,
  START_SESSION,
  WRITE_MEMORY,
} from "@/application/use-cases";
import { CodeEmbeddingWorker } from "@/application/workers";
import { InProcessCodeParser } from "@/code/unit-parser";
import { PG_TOKEN, type PgDatabase } from "@/db/postgres/database";
import { setup, type TestEnv } from "@test/helpers";
import { TEST_BACKEND } from "@test/pg";

const REMOTE = "github.com/acme/widgets";
const MAIN: CodeContext = { remote_key: REMOTE, branch: "main" };
const FEATURE: CodeContext = { remote_key: REMOTE, branch: "feature" };

const UTIL = `export function hashToken(input: string): string {
  return input.split("").reverse().join("");
}
`;
const AUTH = `import { hashToken } from "./util";

export class AuthService {
  /** Validate a login attempt. */
  validate(pw: string): boolean {
    return hashToken(pw).length > 0;
  }
}
`;
const AUTH_FEATURE = `import { hashToken } from "./util";

export class AuthService {
  /** Validate a login attempt, rejecting blanks. */
  validate(pw: string): boolean {
    return pw.trim().length > 0 && hashToken(pw).length > 0;
  }

  logout(): void {}
}
`;

let env: TestEnv;
let session: string;

function db(): PgDatabase {
  return container.resolve<PgDatabase>(PG_TOKEN);
}

async function rows<T>(sql: string, params: Record<string, unknown> = {}): Promise<T[]> {
  return (await db().query(sql, params)).rows as T[];
}

// Uploads what the host lacks and commits `files` as the branch's live set.
async function index(branch: string, files: Record<string, string>, branches?: string[]) {
  const entries = Object.entries(files).map(([path, content]) => ({
    path,
    content,
    hash: sha256Hex(content),
  }));
  const { missing } = await container
    .resolve(CODE_MANIFEST)
    .invoke({ session_id: session, hashes: entries.map((e) => e.hash) });
  const wanted = new Set(missing);

  await container.resolve(CODE_UPLOAD).invoke({
    session_id: session,
    blobs: entries
      .filter((e) => wanted.has(e.hash))
      .map((e) => ({ hash: e.hash, content: gzipSync(e.content).toString("base64") })),
  });

  return container.resolve(CODE_COMMIT).invoke({
    session_id: session,
    remote_key: REMOTE,
    default_branch: "main",
    branch,
    commit: `${branch}-sha`,
    files: entries.map((e) => ({ path: e.path, hash: e.hash })),
    ...(branches === undefined ? {} : { branches }),
  });
}

function lookup(name: string, code_context?: CodeContext, branch?: string) {
  return container.resolve(LOOKUP_CODE).invoke({
    session_id: session,
    name,
    limit: 10,
    ...(code_context === undefined ? {} : { code_context }),
    ...(branch === undefined ? {} : { branch }),
  });
}

async function note(title: string, content: string): Promise<string> {
  const written = await container.resolve(WRITE_MEMORY).invoke({
    session_id: session,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title,
    content,
    project: "widgets",
    parent_node_id: null,
  });

  return written.envelope.id;
}

describe.skipIf(TEST_BACKEND !== "postgres")("The per-branch code index", () => {
  beforeEach(async () => {
    env = setup();
    container.register(CODE_PARSER_TOKEN, { useValue: new InProcessCodeParser() });
    session = (
      await container
        .resolve(START_SESSION)
        .invoke({ project: "widgets", client: { client: "t", version: "1" } })
    ).session_id;
  });

  it("should ask only for contents the host lacks, and parse each (content, path) once", async () => {
    // Given
    await index("main", { "src/util.ts": UTIL, "src/auth.ts": AUTH });

    // When
    const again = await container.resolve(CODE_MANIFEST).invoke({
      session_id: session,
      hashes: [sha256Hex(UTIL), sha256Hex(AUTH_FEATURE)],
    });
    const second = await index("feature", { "src/util.ts": UTIL, "src/auth.ts": AUTH_FEATURE });

    // Then
    expect(again.missing).toEqual([sha256Hex(AUTH_FEATURE)]);
    expect(second.units_parsed).toBe(1);
    expect(await rows("SELECT COUNT(*)::int AS c FROM code_units")).toEqual([{ c: 3 }]);
  });

  it("should reject an upload whose content does not match its hash", async () => {
    // Given
    const forged = gzipSync("export const x = 1;\n").toString("base64");

    // When
    const res = await container.resolve(CODE_UPLOAD).invoke({
      session_id: session,
      blobs: [{ hash: sha256Hex("something else"), content: forged }],
    });

    // Then
    expect(res.stored).toBe(0);
    expect(res.rejected[0]?.reason).toBe("content does not match its hash");
  });

  it("should index a source that carries a NUL inside a string literal", async () => {
    // Given
    const withNul =
      'export const SEP = "\u0000";\nexport function join(a: string): string {\n  return a + SEP;\n}\n';

    // When
    const res = await index("main", { "src/sep.ts": withNul });

    // Then
    expect(res.parse_failures).toBe(0);
    expect((await lookup("join", MAIN)).symbols.map((s) => s.facets.qualified)).toEqual([
      "src/sep.ts:join",
    ]);
  });

  it("should refuse to commit files whose contents were never uploaded", async () => {
    // Given / When / Then
    await expect(
      container.resolve(CODE_COMMIT).invoke({
        session_id: session,
        remote_key: REMOTE,
        branch: "main",
        files: [{ path: "src/a.ts", hash: sha256Hex("never sent") }],
      }),
    ).rejects.toThrow(/never uploaded/);
  });

  it("should answer code from the caller's branch only", async () => {
    // Given
    await index("main", { "src/util.ts": UTIL, "src/auth.ts": AUTH });
    await index("feature", { "src/util.ts": UTIL, "src/auth.ts": AUTH_FEATURE });

    // When
    const onMain = await lookup("logout", MAIN);
    const onFeature = await lookup("logout", FEATURE);

    // Then
    expect(onMain.symbols).toEqual([]);
    expect(onFeature.symbols.map((s) => s.facets.qualified)).toEqual([
      "src/auth.ts:AuthService.logout",
    ]);
    expect(onFeature.symbols[0]!.facets.branch).toBe("feature");
    expect((await lookup("src/auth.ts:AuthService.validate", MAIN)).symbols[0]!.facets.branch).toBe(
      "main",
    );
  });

  it("should resolve calls across files on the branch, in both directions", async () => {
    // Given
    await index("main", { "src/util.ts": UTIL, "src/auth.ts": AUTH });

    // When
    const [validate] = (await lookup("src/auth.ts:AuthService.validate", MAIN)).symbols;
    const [hash] = (await lookup("hashToken", MAIN)).symbols;

    // Then
    expect(validate!.neighbors).toContainEqual(
      expect.objectContaining({ title: "src/util.ts:hashToken", edge: "calls", direction: "out" }),
    );
    expect(hash!.neighbors).toContainEqual(
      expect.objectContaining({
        title: "src/auth.ts:AuthService.validate",
        edge: "calls",
        direction: "in",
      }),
    );
  });

  it("should read the default branch, and say so, when the caller's branch is not indexed", async () => {
    // Given
    await index("main", { "src/util.ts": UTIL });

    // When
    const res = await lookup("hashToken", { remote_key: REMOTE, branch: "wip" });

    // Then
    expect(res.symbols.map((s) => s.facets.branch)).toEqual(["main"]);
    expect(res.notes?.join(" ")).toContain(
      "widgets@wip is not indexed yet; reading the default branch main",
    );
  });

  it("should retire a removed file's row and never delete a symbol", async () => {
    // Given
    await index("main", { "src/util.ts": UTIL, "src/auth.ts": AUTH });
    const before = env.clock.now();
    const symbols = await rows<{ c: number }>("SELECT COUNT(*)::int AS c FROM code_symbols");
    env.clock.advanceMs(60_000);

    // When
    const change = await index("main", { "src/util.ts": UTIL });
    const history = await rows<{ path: string; invalidated: boolean }>(
      `SELECT path, invalidated_at IS NOT NULL AS invalidated FROM code_branch_files
       WHERE branch = 'main' ORDER BY path`,
    );
    const [asOf] = (
      await container.resolve(SEARCH_MEMORY).invoke({
        session_id: session,
        query: "AuthService",
        limit: 5,
        mode: "text",
        types: ["symbol"],
        as_of: before,
        code_context: MAIN,
      })
    ).results;

    // Then
    expect(change.files_removed).toBe(1);
    expect(history).toEqual([
      { path: "src/auth.ts", invalidated: true },
      { path: "src/util.ts", invalidated: false },
    ]);
    expect(await rows("SELECT COUNT(*)::int AS c FROM code_symbols")).toEqual(symbols);
    expect((await lookup("AuthService", MAIN)).symbols).toEqual([]);
    expect(asOf?.title).toBe("src/auth.ts:AuthService");
  });

  it("should follow a note's link onto whichever branch a search reads", async () => {
    // Given
    await index("main", { "src/util.ts": UTIL, "src/auth.ts": AUTH });
    await index("feature", { "src/util.ts": UTIL, "src/auth.ts": AUTH_FEATURE });
    await index("gone", { "src/util.ts": UTIL });
    const [validate] = (await lookup("src/auth.ts:AuthService.validate", MAIN)).symbols;
    const id = await note("Login validation rule", "passwords are hashed before the length check");
    await container.resolve(LINK_NODES).invoke({
      session_id: session,
      src: id,
      dst: validate!.envelope.id,
      type: EdgeType.DOCUMENTS,
      code_context: MAIN,
    });
    const search = (ctx: CodeContext) =>
      container.resolve(SEARCH_MEMORY).invoke({
        session_id: session,
        query: "passwords hashed length check",
        limit: 10,
        code_context: ctx,
      });

    // When
    const main = (await search(MAIN)).results.find((r) => r.type === "symbol");
    const feature = (await search(FEATURE)).results.find((r) => r.type === "symbol");
    const gone = (await search({ remote_key: REMOTE, branch: "gone" })).results.find(
      (r) => r.type === "symbol",
    );

    // Then
    expect(main).toMatchObject({
      id: validate!.envelope.id,
      matched: "graph",
      via: { node: id, edge: "documents" },
    });
    expect(feature?.title).toBe("src/auth.ts:AuthService.validate");
    expect(feature?.id).not.toBe(validate!.envelope.id);
    expect(gone).toBeUndefined();
    expect(
      await rows("SELECT repo, remote_key, path, qualified FROM code_refs WHERE src = @id", { id }),
    ).toEqual([
      {
        repo: "widgets",
        remote_key: REMOTE,
        path: "src/auth.ts",
        qualified: "src/auth.ts:AuthService.validate",
      },
    ]);
  });

  it("should keep a note's code link made at write time", async () => {
    // Given
    await index("main", { "src/util.ts": UTIL });
    const [hash] = (await lookup("hashToken", MAIN)).symbols;

    // When
    const written = await container.resolve(WRITE_MEMORY).invoke({
      session_id: session,
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title: "Token hashing",
      content: "hashToken reverses its input; it is not a real hash",
      project: "widgets",
      parent_node_id: null,
      links: [{ dst: hash!.envelope.id, type: EdgeType.DOCUMENTS }],
      code_context: MAIN,
    });

    // Then
    expect(
      await rows("SELECT qualified FROM code_refs WHERE src = @id", { id: written.envelope.id }),
    ).toEqual([{ qualified: "src/util.ts:hashToken" }]);
  });

  it("should return a symbol's source through get, with the branches that hold it", async () => {
    // Given
    await index("main", { "src/util.ts": UTIL });
    await index("feature", { "src/util.ts": UTIL });
    const [hash] = (await lookup("hashToken", MAIN)).symbols;

    // When
    const got = await container
      .resolve(FETCH_NODES)
      .invoke({ session_id: session, ids: [hash!.envelope.id], code_context: MAIN });
    const node = got.nodes[0] as { source: string; symbol: { live_on: string[] } };

    // Then
    expect(got.not_found).toEqual([]);
    expect(node.source).toContain("reverse()");
    expect(node.symbol.live_on).toEqual(["widgets@feature", "widgets@main"]);
  });

  it("should search symbols directly only when they are asked for", async () => {
    // Given
    await index("main", { "src/util.ts": UTIL });
    const query = {
      session_id: session,
      query: "hashToken",
      limit: 10,
      mode: "text" as const,
      code_context: MAIN,
    };

    // When
    const plain = await container.resolve(SEARCH_MEMORY).invoke(query);
    const symbols = await container.resolve(SEARCH_MEMORY).invoke({ ...query, types: ["symbol"] });

    // Then
    expect(plain.results.filter((r) => r.type === "symbol")).toEqual([]);
    expect(symbols.results.map((r) => r.title)).toContain("src/util.ts:hashToken");
  });

  it("should embed each symbol summary once and find it by meaning on the branch", async () => {
    // Given
    await index("main", { "src/util.ts": UTIL, "src/auth.ts": AUTH });
    const worker = container.resolve(CodeEmbeddingWorker);

    // When
    while ((await worker.tick()).embedded > 0);
    const backlog = await worker.backlog();
    const found = await container.resolve(SEARCH_MEMORY).invoke({
      session_id: session,
      query: "validate a login attempt",
      limit: 5,
      mode: "vector",
      types: ["symbol"],
      code_context: MAIN,
    });

    // Then
    expect(backlog).toBe(0);
    expect(found.results.length).toBeGreaterThan(0);
    expect(found.results.every((r) => r.type === "symbol")).toBe(true);
  });

  it("should retire a branch the repo no longer has, once it has been gone long enough", async () => {
    // Given
    await index("main", { "src/util.ts": UTIL }, ["main", "old"]);
    await index("old", { "src/util.ts": UTIL }, ["main", "old"]);
    env.clock.advanceDays(15);

    // When
    const res = await index("main", { "src/util.ts": UTIL }, ["main"]);

    // Then
    expect(res.branches_retired).toEqual(["old"]);
    expect((await lookup("hashToken", undefined, "old")).symbols).toEqual([]);
    expect(
      await rows(
        "SELECT branch, retired_at IS NOT NULL AS retired FROM code_branches ORDER BY branch",
      ),
    ).toEqual([
      { branch: "main", retired: false },
      { branch: "old", retired: true },
    ]);
  });

  it("should take the branch from the transport, never from the arguments", async () => {
    // Given
    await index("main", { "src/util.ts": UTIL });
    await index("feature", { "src/util.ts": UTIL, "src/auth.ts": AUTH_FEATURE });
    const pipeline = container.resolve(CallPipeline);

    // When
    const res = (await pipeline.invoke(
      container,
      "lookup_code",
      { session_id: session, name: "logout", limit: 5, code_context: FEATURE },
      { client: "t", version: "1", code: MAIN },
    )) as { symbols: unknown[] };

    // Then
    expect(res.symbols).toEqual([]);
  });
});
