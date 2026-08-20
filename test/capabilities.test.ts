import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { CallPipeline } from "@/application/call-pipeline";
import { CapabilityDeniedError } from "@/application/errors";
import { CALL_SURFACE, callCapability, type CallName } from "@/application/use-cases";
import { Capability, MemoryKind, Posture, UNATTRIBUTED_PRINCIPAL } from "@/core/vocab";
import {
  NEUTRAL_WEIGHT,
  OPEN_PROFILE,
  PrincipalsConfig,
  StaticConfigSource,
  type PrincipalProfile,
  type PrincipalQuota,
} from "@/infrastructure/config";
import { setup, type TestEnv } from "@test/helpers";

let env: TestEnv;

function profile(
  capabilities: PrincipalProfile["capabilities"],
  quota: PrincipalQuota = {},
): PrincipalProfile {
  return { capabilities, quota, weight: NEUTRAL_WEIGHT };
}

// The pipeline reads policy through PrincipalsConfig, so a test states the policy by
// registering the section rather than by writing a config file.
function pipelineWith(profiles: Record<string, PrincipalProfile>, fallback = OPEN_PROFILE) {
  container.register(PrincipalsConfig, {
    useValue: { profiles, default: fallback },
  });

  return container.resolve(CallPipeline);
}

async function session(pipeline: CallPipeline, client: string | null): Promise<string> {
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

function write(session_id: string): Record<string, unknown> {
  return {
    session_id,
    parent_node_id: null,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title: "A fact",
    content: "a durable fact with enough words in it to make a chunk worth embedding",
  };
}

// The test clock is frozen, so every row shares a timestamp and "the last event" is a
// ULID tie-break rather than an ordering. Ask whether the row is there instead.
function logged(fragment: string): boolean {
  return (env.db.prepare("SELECT detail FROM events").all() as { detail: string | null }[]).some(
    (row) => row.detail?.includes(fragment) === true,
  );
}

beforeEach(() => {
  env = setup();
});

describe("Capability classification", () => {
  it("should classify every call on the surface", () => {
    // Given / When / Then — an unclassified call would slip past policy entirely.
    for (const name of Object.keys(CALL_SURFACE) as CallName[]) {
      expect(Object.values(Capability)).toContain(callCapability(name));
    }
  });

  it("should let a read-only principal still open the session it reads in", () => {
    // Given / When / Then — `start_session` is a write by dispatch and a read by policy.
    expect(callCapability("start_session")).toBe(Capability.READ);
    expect(callCapability("search_memory")).toBe(Capability.READ);
    expect(callCapability("write_memory")).toBe(Capability.WRITE);
    expect(callCapability("apply_candidate")).toBe(Capability.CONSOLIDATE);
    expect(callCapability("index_code")).toBe(Capability.ADMIN);
  });
});

describe("Capability enforcement", () => {
  it("should permit everything when no principal is configured", async () => {
    // Given
    const pipeline = pipelineWith({});

    // When / Then — adding policy must change nothing for a deployment that sets none.
    const id = await session(pipeline, "claude-code");
    await expect(pipeline.invoke(container, "write_memory", write(id))).resolves.toBeDefined();
  });

  it("should refuse a call the principal has no capability for", async () => {
    // Given
    const pipeline = pipelineWith({
      "codex-mcp-client": profile({ [Capability.WRITE]: Posture.OFF }),
    });
    const id = await session(pipeline, "codex-mcp-client");

    // When / Then
    await expect(
      pipeline.invoke(container, "write_memory", write(id), {
        client: "codex-mcp-client",
        version: null,
      }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
  });

  it("should leave the capabilities it did not revoke alone", async () => {
    // Given — revocation has to be selective or it is just an off switch.
    const pipeline = pipelineWith({
      "codex-mcp-client": profile({ [Capability.WRITE]: Posture.OFF }),
    });
    const id = await session(pipeline, "codex-mcp-client");

    // When / Then
    await expect(
      pipeline.invoke(
        container,
        "search_memory",
        { session_id: id, query: "anything", limit: 5 },
        {
          client: "codex-mcp-client",
          version: null,
        },
      ),
    ).resolves.toBeDefined();
  });

  it("should refuse before the call runs, and say so in the audit log", async () => {
    // Given
    const pipeline = pipelineWith({
      "codex-mcp-client": profile({ [Capability.WRITE]: Posture.OFF }),
    });
    const id = await session(pipeline, "codex-mcp-client");
    const before = env.db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number };

    // When
    await expect(
      pipeline.invoke(container, "write_memory", write(id), {
        client: "codex-mcp-client",
        version: null,
      }),
    ).rejects.toThrow(/not permitted to write/);

    // Then — nothing written, and the refusal is on the record.
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM nodes").get()).toEqual(before);
    expect(logged("not permitted to write")).toBe(true);
  });

  it("should let a suggested capability through and mark it for review", async () => {
    // Given — the point of `suggest` is to keep what a suspect writer had to say.
    const pipeline = pipelineWith({
      "codex-mcp-client": profile({ [Capability.WRITE]: Posture.SUGGEST }),
    });
    const id = await session(pipeline, "codex-mcp-client");

    // When
    const written = await pipeline.invoke(container, "write_memory", write(id), {
      client: "codex-mcp-client",
      version: null,
    });

    // Then
    expect(written).toBeDefined();
    expect(logged('"review":true')).toBe(true);
  });

  it("should fall back to the default profile for a principal it does not name", async () => {
    // Given
    const pipeline = pipelineWith(
      { "claude-code": profile({ [Capability.WRITE]: Posture.AUTO }) },
      profile({ [Capability.WRITE]: Posture.OFF }),
    );

    // When / Then — the named one keeps its grant, everyone else takes the default.
    const named = await session(pipeline, "claude-code");
    await expect(
      pipeline.invoke(container, "write_memory", write(named), {
        client: "claude-code",
        version: null,
      }),
    ).resolves.toBeDefined();

    const other = await session(pipeline, "antigravity-client");
    await expect(
      pipeline.invoke(container, "write_memory", write(other), {
        client: "antigravity-client",
        version: null,
      }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
  });

  it("should govern a writer that never named itself", async () => {
    // Given — the pre-identity majority of a store has to be addressable by policy.
    const pipeline = pipelineWith({
      [UNATTRIBUTED_PRINCIPAL]: profile({ [Capability.WRITE]: Posture.OFF }),
    });
    const id = await session(pipeline, null);

    // When / Then
    await expect(pipeline.invoke(container, "write_memory", write(id))).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
  });
});

describe("Principal policy config", () => {
  function parse(values: Record<string, string | undefined>): PrincipalsConfig {
    return new PrincipalsConfig(new StaticConfigSource(values));
  }

  it("should read a per-principal profile out of the JSON tier", () => {
    // Given / When
    const config = parse({
      MEMORY_PRINCIPALS: JSON.stringify({ "codex-mcp-client": { capabilities: { write: "off" } } }),
    });

    // Then
    expect(config.profiles["codex-mcp-client"]).toEqual({
      capabilities: { write: Posture.OFF },
      quota: {},
      weight: NEUTRAL_WEIGHT,
    });
  });

  it("should permit everything when nothing is configured", () => {
    // Given / When / Then
    expect(parse({}).profiles).toEqual({});
    expect(parse({}).default).toEqual(OPEN_PROFILE);
  });

  it("should fall back rather than half-apply a profile it cannot read", () => {
    // Given — a typo that widened the other principals into defaults would be the worst
    // possible failure mode for a permission file.
    const config = parse({
      MEMORY_PRINCIPALS: JSON.stringify({
        "claude-code": { capabilities: { write: "off" } },
        "codex-mcp-client": { capabilities: { write: "nope" } },
      }),
    });

    // Then
    expect(config.profiles).toEqual({});
  });

  it("should reject a capability name it does not know", () => {
    // Given / When
    const config = parse({
      MEMORY_PRINCIPALS: JSON.stringify({ "claude-code": { capabilities: { destroy: "off" } } }),
    });

    // Then
    expect(config.profiles).toEqual({});
  });
});
