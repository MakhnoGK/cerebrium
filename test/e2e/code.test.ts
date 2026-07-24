import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCtx } from "../helpers";
import * as session_start from "@/tools/session_start";
import * as code_index from "@/tools/code_index";
import * as search from "@/tools/search";
import * as get from "@/tools/get";
import * as write from "@/tools/write";
import * as link from "@/tools/link";
import type { EmbeddingWorker } from "@/embeddings/worker";

const CRYPTO = `export function hashToken(input: string): string {
  return input.split("").reverse().join("");
}
`;
const AUTH = `import { hashToken } from "../util/crypto";

export class AuthService {
  /** Validate a login attempt. */
  validate(pw: string): boolean {
    return hashToken(pw).length > 0;
  }
}
`;

let root: string;

function writeFile(rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

async function drain(worker: EmbeddingWorker): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const r = await worker.tick();
    if (r.embedded === 0 && r.failed === 0) break;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mk-e2e-"));
  writeFile("util/crypto.ts", CRYPTO);
  writeFile("auth/auth.service.ts", AUTH);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Res {
  results: { id: string; kind: string; type: string; via?: { edge: string; node: string } }[];
}

// Acceptance §9.3 — index → search → get → link a note → note-topic search surfaces
// the symbol via graph expansion → edit + re-index keeps the documents edge.
describe("code indexing end-to-end", () => {
  it("carries a note→code documents link across a re-index", async () => {
    const { ctx, repo, clock, worker, db } = makeCtx();
    const s = (await session_start.handler(ctx, {})).session_id;

    // 1. index the repo
    const stats = (await code_index.handler(ctx, { session_id: s, path: root })) as {
      repo: string;
    };
    const repoName = stats.repo;
    const validateId = repo.findSymbolsByName("validate", repoName, 1)[0]!.envelope.id;

    // 2. FTS-findable immediately, before any embedding runs
    expect(
      (
        db.prepare("SELECT pending_embedding AS p FROM nodes WHERE id = ?").get(validateId) as {
          p: number;
        }
      ).p,
    ).toBe(1);
    const byText = (await search.handler(ctx, {
      session_id: s,
      query: "validate login",
      mode: "text",
      limit: 10,
    })) as unknown as Res;
    expect(byText.results.some((r) => r.id === validateId)).toBe(true);

    // 3. get shows the raw source
    const got = (await get.handler(ctx, { session_id: s, ids: [validateId] })) as {
      nodes: { source: string }[];
    };
    expect(got.nodes[0]!.source).toContain("hashToken(pw)");

    // 4. write a decision ABOUT the code + link it with a documents edge
    const note = (await write.handler(ctx, {
      session_id: s,
      memory_kind: "semantic",
      type: "decision",
      title: "Signing choice",
      content: "We validate credentials by signing with RS256 rather than HS256.",
      project: repoName,
    })) as { id: string };
    await link.handler(ctx, { session_id: s, src: note.id, dst: validateId, type: "documents" });

    // 5. searching the NOTE's topic surfaces the symbol via graph expansion
    const viaGraph = (await search.handler(ctx, {
      session_id: s,
      query: "RS256 signing",
      limit: 10,
    })) as unknown as Res;
    const surfaced = viaGraph.results.find((r) => r.id === validateId);
    expect(surfaced).toBeDefined();
    expect(surfaced!.via?.edge).toBe("documents");

    // 6. after embeddings drain, vector search finds the symbol by meaning
    await drain(worker);
    const byVec = (await search.handler(ctx, {
      session_id: s,
      query: "validate login boolean",
      mode: "vector",
      limit: 10,
    })) as unknown as Res;
    expect(byVec.results.some((r) => r.id === validateId)).toBe(true);

    // 7. edit the symbol's source + re-index → same node, revised; documents edge intact
    writeFile(
      "auth/auth.service.ts",
      AUTH.replace("length > 0", "length > 1").replace(
        "Validate a login attempt.",
        "Validate a login attempt strictly.",
      ),
    );
    clock.advanceDays(1);
    await code_index.handler(ctx, { session_id: s, path: root });

    expect(repo.findSymbolsByName("validate", repoName, 1)[0]!.envelope.id).toBe(validateId); // stable id
    const edge = db
      .prepare(
        "SELECT dst FROM edges WHERE src = ? AND type = 'documents' AND invalidated_at IS NULL",
      )
      .get(note.id) as { dst: string } | undefined;
    expect(edge?.dst).toBe(validateId);
    const stillGraph = (await search.handler(ctx, {
      session_id: s,
      query: "RS256 signing",
      limit: 10,
    })) as unknown as Res;
    expect(stillGraph.results.find((r) => r.id === validateId)?.via?.edge).toBe("documents");
  });

  it("mirror symbols are code-scoped and do not decay", async () => {
    const { ctx, clock } = makeCtx();
    const s = (await session_start.handler(ctx, {})).session_id;
    const stats = (await code_index.handler(ctx, { session_id: s, path: root })) as {
      repo: string;
    };

    // an equally-matching episodic note that WILL decay
    await write.handler(ctx, {
      session_id: s,
      memory_kind: "episodic",
      type: "event_note",
      title: "validate incident",
      content: "validate failed intermittently in prod",
      project: stats.repo,
    });

    // types filter scopes strictly to code
    const scoped = (await search.handler(ctx, {
      session_id: s,
      query: "validate",
      types: ["symbol"],
      limit: 10,
    })) as {
      results: { kind: string; type: string }[];
    };
    expect(scoped.results.length).toBeGreaterThan(0);
    expect(scoped.results.every((r) => r.type === "symbol" && r.kind === "mirror")).toBe(true);

    // age 60 days: the symbol (no decay) outranks the decayed episodic note
    clock.advanceDays(60);
    const aged = (await search.handler(ctx, {
      session_id: s,
      query: "validate",
      mode: "text",
      limit: 10,
    })) as {
      results: { type: string }[];
    };
    const symIdx = aged.results.findIndex((r) => r.type === "symbol");
    const epIdx = aged.results.findIndex((r) => r.type === "event_note");
    expect(symIdx).toBeGreaterThanOrEqual(0);
    expect(epIdx).toBeGreaterThan(symIdx);
  });
});
