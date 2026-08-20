import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { CallPipeline } from "@/application/call-pipeline";
import { QuotaExceededError } from "@/application/errors";
import { PrincipalQuotaService } from "@/application/services";
import { Capability, MemoryKind, Posture } from "@/core/vocab";
import {
  OPEN_PROFILE,
  PrincipalsConfig,
  StaticConfigSource,
  type PrincipalProfile,
  type PrincipalQuota,
} from "@/infrastructure/config";
import { setup, type TestEnv } from "@test/helpers";

let env: TestEnv;

function quotaProfile(quota: PrincipalQuota): PrincipalProfile {
  return { capabilities: {}, quota };
}

function pipelineWith(profiles: Record<string, PrincipalProfile>, fallback = OPEN_PROFILE) {
  container.register(PrincipalsConfig, {
    useValue: { profiles, default: fallback },
  });

  return container.resolve(CallPipeline);
}

async function session(pipeline: CallPipeline, client: string): Promise<string> {
  const started = (await pipeline.invoke(
    container,
    "start_session",
    {},
    {
      client,
      version: null,
    },
  )) as { session_id: string };

  return started.session_id;
}

function write(session_id: string, title: string): Record<string, unknown> {
  return {
    session_id,
    parent_node_id: null,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title,
    content: "a durable fact with enough words in it to make a chunk worth embedding",
  };
}

const AS = { client: "codex-mcp-client", version: null };

beforeEach(() => {
  env = setup();
});

describe("Per-principal quotas", () => {
  it("should not limit a principal with no quota configured", async () => {
    // Given
    const pipeline = pipelineWith({});
    const id = await session(pipeline, "codex-mcp-client");

    // When / Then
    for (const n of [1, 2, 3, 4, 5]) {
      await expect(
        pipeline.invoke(container, "write_memory", write(id, `Fact ${String(n)}`), AS),
      ).resolves.toBeDefined();
    }
  });

  it("should refuse a write once the writer is over its write ceiling", async () => {
    // Given
    const pipeline = pipelineWith({ "codex-mcp-client": quotaProfile({ writes: 2 }) });
    const id = await session(pipeline, "codex-mcp-client");

    // When
    await pipeline.invoke(container, "write_memory", write(id, "First"), AS);
    await pipeline.invoke(container, "write_memory", write(id, "Second"), AS);

    // Then
    await expect(
      pipeline.invoke(container, "write_memory", write(id, "Third"), AS),
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("should keep reads flowing for a writer that used up its write budget", async () => {
    // Given — a noisy writer is rate-limited, not cut off from the store it needs.
    const pipeline = pipelineWith({ "codex-mcp-client": quotaProfile({ writes: 1 }) });
    const id = await session(pipeline, "codex-mcp-client");
    await pipeline.invoke(container, "write_memory", write(id, "First"), AS);

    // When / Then
    await expect(
      pipeline.invoke(container, "search_memory", { session_id: id, query: "x", limit: 5 }, AS),
    ).resolves.toBeDefined();
  });

  it("should let the window slide rather than latching the writer off", async () => {
    // Given
    const pipeline = pipelineWith({
      "codex-mcp-client": quotaProfile({ writes: 1, windowMs: 60_000 }),
    });
    const id = await session(pipeline, "codex-mcp-client");
    await pipeline.invoke(container, "write_memory", write(id, "First"), AS);

    // When
    await expect(
      pipeline.invoke(container, "write_memory", write(id, "Second"), AS),
    ).rejects.toBeInstanceOf(QuotaExceededError);
    env.clock.advanceMs(60_001);

    // Then
    await expect(
      pipeline.invoke(container, "write_memory", write(id, "Third"), AS),
    ).resolves.toBeDefined();
  });

  it("should count one principal's calls apart from another's", async () => {
    // Given
    const pipeline = pipelineWith({}, quotaProfile({ writes: 1 }));
    const codex = await session(pipeline, "codex-mcp-client");
    const claude = await session(pipeline, "claude-code");
    await pipeline.invoke(container, "write_memory", write(codex, "Theirs"), AS);

    // When / Then — the other writer's budget is untouched.
    await expect(
      pipeline.invoke(container, "write_memory", write(claude, "Mine"), {
        client: "claude-code",
        version: null,
      }),
    ).resolves.toBeDefined();
  });

  it("should say how long the caller has to wait", async () => {
    // Given
    const quotas = new PrincipalQuotaService();
    quotas.consume("codex-mcp-client", Capability.WRITE, { writes: 1, windowMs: 60_000 }, 1_000);

    // When
    const refusal = (() => {
      try {
        quotas.consume(
          "codex-mcp-client",
          Capability.WRITE,
          { writes: 1, windowMs: 60_000 },
          21_000,
        );
      } catch (err) {
        return err as QuotaExceededError;
      }

      return null;
    })();

    // Then — 60s window opened at 1s, asked again at 21s, so 40s remain.
    expect(refusal?.retryAfterMs).toBe(40_000);
    expect(refusal?.message).toMatch(/Retry in about 40s/);
  });

  it("should report what each principal has spent in the window", () => {
    // Given
    const quotas = new PrincipalQuotaService();
    quotas.consume("claude-code", Capability.WRITE, { calls: 10 }, 1_000);
    quotas.consume("claude-code", Capability.READ, { calls: 10 }, 1_100);
    quotas.consume("codex-mcp-client", Capability.READ, { calls: 10 }, 1_200);

    // When / Then
    expect(quotas.usage(2_000)).toEqual([
      { principal: "claude-code", calls: 2, writes: 1 },
      { principal: "codex-mcp-client", calls: 1, writes: 0 },
    ]);
  });
});

describe("Quota config", () => {
  function parse(values: Record<string, string | undefined>): PrincipalsConfig {
    return new PrincipalsConfig(new StaticConfigSource(values));
  }

  it("should read ceilings alongside capabilities", () => {
    // Given / When
    const config = parse({
      MEMORY_PRINCIPALS: JSON.stringify({
        "codex-mcp-client": { capabilities: { write: "suggest" }, quota: { writes: 20 } },
      }),
    });

    // Then
    expect(config.profiles["codex-mcp-client"]).toEqual({
      capabilities: { write: Posture.SUGGEST },
      quota: { writes: 20 },
    });
  });

  it("should fall back rather than accept a ceiling that is not a whole count", () => {
    // Given / When / Then
    expect(
      parse({ MEMORY_PRINCIPALS: JSON.stringify({ a: { quota: { writes: -1 } } }) }).profiles,
    ).toEqual({});
    expect(
      parse({ MEMORY_PRINCIPALS: JSON.stringify({ a: { quota: { writes: 1.5 } } }) }).profiles,
    ).toEqual({});
    expect(
      parse({ MEMORY_PRINCIPALS: JSON.stringify({ a: { quota: { nope: 1 } } }) }).profiles,
    ).toEqual({});
  });
});
