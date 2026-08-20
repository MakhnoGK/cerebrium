import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { CallPipeline } from "@/application/call-pipeline";
import { NodesRepo } from "@/db/repositories";
import { MemoryKind } from "@/core/vocab";
import {
  NEUTRAL_WEIGHT,
  OPEN_PROFILE,
  PrincipalsConfig,
  StaticConfigSource,
  type PrincipalProfile,
} from "@/infrastructure/config";
import { setup, type TestEnv } from "@test/helpers";

let env: TestEnv;

function weighted(weight: number): PrincipalProfile {
  return { capabilities: {}, quota: {}, weight };
}

function policy(profiles: Record<string, PrincipalProfile>, fallback = OPEN_PROFILE) {
  container.register(PrincipalsConfig, {
    useValue: { profiles, default: fallback },
  });

  return container.resolve(CallPipeline);
}

const TOPIC = "the http client retries with exponential backoff on a 503";

async function writeAs(client: string, title: string): Promise<string> {
  // A fresh pipeline each time so it reads whatever policy the test has registered.
  const pipeline = container.resolve(CallPipeline);
  const as = { client, version: null };
  const { session_id } = (await pipeline.invoke(container, "start_session", {}, as)) as {
    session_id: string;
  };
  const written = (await pipeline.invoke(
    container,
    "write_memory",
    {
      session_id,
      parent_node_id: null,
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title,
      content: TOPIC,
    },
    as,
  )) as { envelope: { id: string } };

  return written.envelope.id;
}

async function search(): Promise<string[]> {
  const found = (await container
    .resolve(CallPipeline)
    .invoke(container, "search_memory", { query: TOPIC, limit: 10, mode: "text" })) as {
    results: { id: string }[];
  };

  return found.results.map((r) => r.id);
}

beforeEach(() => {
  env = setup();
  policy({});
});

describe("Trust weight at read time", () => {
  it("should return both writers' nodes when nobody is weighted", async () => {
    // Given
    const theirs = await writeAs("codex-mcp-client", "Retry budget, theirs");
    const mine = await writeAs("claude-code", "Retry budget, mine");

    // When
    policy({});

    // Then
    expect(await search()).toEqual(expect.arrayContaining([theirs, mine]));
  });

  it("should rank a down-weighted writer's node below an equally relevant one", async () => {
    // Given — same content from two writers, so only the weight separates them.
    const quiet = await writeAs("codex-mcp-client", "Retry budget");
    const loud = await writeAs("claude-code", "Retry budget");

    // When
    policy({ "codex-mcp-client": weighted(0.1) });
    const ranked = await search();

    // Then
    expect(ranked.indexOf(loud)).toBeLessThan(ranked.indexOf(quiet));
  });

  it("should hide a revoked writer's nodes from retrieval", async () => {
    // Given
    const revoked = await writeAs("codex-mcp-client", "Retry budget, theirs");
    const kept = await writeAs("claude-code", "Retry budget, mine");

    // When
    policy({ "codex-mcp-client": weighted(0) });

    // Then
    const found = await search();

    expect(found).toEqual([kept]);
    expect(found).not.toContain(revoked);
  });

  it("should revoke without deleting or invalidating anything", async () => {
    // Given — this is the whole point: the node is still there and still live.
    const revoked = await writeAs("codex-mcp-client", "Retry budget, theirs");
    policy({ "codex-mcp-client": weighted(0) });
    expect(await search()).not.toContain(revoked);

    // When / Then
    const row = env.db
      .prepare("SELECT id, invalidated_at FROM nodes WHERE id = ?")
      .get(revoked) as { id: string; invalidated_at: string | null };

    expect(row).toEqual({ id: revoked, invalidated_at: null });
  });

  it("should bring a revoked writer's nodes straight back when the weight is restored", async () => {
    // Given
    const revoked = await writeAs("codex-mcp-client", "Retry budget, theirs");
    policy({ "codex-mcp-client": weighted(0) });
    expect(await search()).not.toContain(revoked);

    // When
    policy({ "codex-mcp-client": weighted(NEUTRAL_WEIGHT) });

    // Then
    expect(await search()).toContain(revoked);
  });

  it("should leave the code mirror out of trust weighting entirely", async () => {
    // Given — a symbol's session is whichever run indexed it, so weighting it by that
    // run's principal would score derived rows by who last refreshed the index.
    const authored = await writeAs("codex-mcp-client", "Retry budget");
    const session = (
      env.db.prepare("SELECT created_by_session AS s FROM nodes WHERE id = ?").get(authored) as {
        s: string;
      }
    ).s;
    env.db
      .prepare(
        `INSERT INTO nodes (id, memory_kind, type, title, valid_from, created_by_session, created_at)
         VALUES (?, 'mirror', 'symbol', 'retry.ts', ?, ?, ?)`,
      )
      .run(
        "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
        "2026-01-01T00:00:00.000Z",
        session,
        "2026-01-01T00:00:00.000Z",
      );

    // When
    const principals = container
      .resolve(NodesRepo)
      .principalsOf([authored, "01ZZZZZZZZZZZZZZZZZZZZZZZZ"]);

    // Then — the authored node resolves to its writer, the mirror row to nobody.
    expect(principals.get(authored)).toBe("codex-mcp-client");
    expect(principals.has("01ZZZZZZZZZZZZZZZZZZZZZZZZ")).toBe(false);
  });
});

describe("Trust weight config", () => {
  function parse(values: Record<string, string | undefined>): PrincipalsConfig {
    return new PrincipalsConfig(new StaticConfigSource(values));
  }

  it("should default every principal to neutral", () => {
    // Given / When / Then
    expect(parse({}).default.weight).toBe(NEUTRAL_WEIGHT);
  });

  it("should read a weight beside the rest of the profile", () => {
    // Given / When
    const config = parse({
      MEMORY_PRINCIPALS: JSON.stringify({ "codex-mcp-client": { weight: 0.25 } }),
    });

    // Then
    expect(config.profiles["codex-mcp-client"]?.weight).toBe(0.25);
  });

  it("should fall back rather than accept a weight that would bury every other writer", () => {
    // Given / When / Then
    expect(parse({ MEMORY_PRINCIPALS: JSON.stringify({ a: { weight: 100 } }) }).profiles).toEqual(
      {},
    );
    expect(parse({ MEMORY_PRINCIPALS: JSON.stringify({ a: { weight: -1 } }) }).profiles).toEqual(
      {},
    );
  });
});
