import { describe, expect, it } from "vitest";
import type {
  AnnotateTask,
  ConsolidationTask,
  ReconcileTask,
} from "@/domain/ports/consolidation-provider";
import { CommandConsolidator } from "@/consolidation/command";
import { HttpConsolidator, type FetchFn } from "@/consolidation/http";
import {
  describeRoles,
  parseRoleOverrides,
  resolveRoles,
  type RoleBase,
} from "@/consolidation/roles";
import { ConsolidationKind, GenerationRole } from "@/core/vocab";
import { ConsolidationConfig, StaticConfigSource } from "@/infrastructure/config";

const BASE: RoleBase = {
  url: "http://host/api/chat",
  model: "big-12b",
  timeoutMs: 500_000,
  reconcileTimeoutMs: 25_000,
};

const TASK: ConsolidationTask = {
  kind: ConsolidationKind.DISTILL,
  project: "cerebrium",
  inputs: [{ id: "a", title: "First", content: "the pipeline was slow" }],
};

const RECONCILE_TASK: ReconcileTask = {
  draft: { title: "Token TTL", type: "fact", content: "tokens expire in 15 minutes" },
  project: "billing",
  candidates: [{ id: "01ABC", title: "Token TTL", content: "access tokens live fifteen minutes" }],
};

const ANNOTATE_TASK: AnnotateTask = {
  title: "Failover behavior",
  content: "the client switches to the standby node",
  project: "infra",
};

interface Sent {
  url: string;
  model: string;
}

// Records what each role's call was actually addressed to. `hang` settles only when the
// signal aborts, which is the part of fetch's contract the adapter's deadline rests on.
function recorder(sent: Sent[], hang = false): FetchFn {
  return (input, init) => {
    // The adapter always passes a string url and a JSON string body; anything else here
    // would be a change to that contract, not a case to handle.
    const body = JSON.parse(init?.body as string) as { model: string };

    sent.push({ url: input as string, model: body.model });

    if (hang) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }

    return Promise.resolve(
      new Response(JSON.stringify({ message: { content: JSON.stringify(REPLY) } }), {
        status: 200,
      }),
    );
  };
}

const REPLY = {
  recommendation: "reject",
  reason: "distinct",
  title: "t",
  summary: "s",
  body: "b",
  action: "noop",
  target_id: null,
  keywords: ["k"],
  tags: ["t"],
  context: "c",
};

describe("Role resolution", () => {
  it("should give every role the flat settings when no role overrides anything", () => {
    // When
    const roles = resolveRoles(BASE);

    // Then
    for (const role of Object.values(GenerationRole)) {
      expect(roles[role].model).toBe("big-12b");
      expect(roles[role].url).toBe("http://host/api/chat");
      expect(roles[role].overrides).toEqual([]);
    }
  });

  it("should give reconcile the interactive budget and the other roles the generation one", () => {
    // When
    const roles = resolveRoles(BASE);

    // Then
    expect(roles[GenerationRole.RECONCILE].timeoutMs).toBe(25_000);
    expect(roles[GenerationRole.RECONCILE].timeoutKnob).toBe(
      "MEMORY_CONSOLIDATE_RECONCILE_TIMEOUT_MS",
    );
    expect(roles[GenerationRole.GENERATE].timeoutMs).toBe(500_000);
    expect(roles[GenerationRole.ANNOTATE].timeoutKnob).toBe("MEMORY_CONSOLIDATE_TIMEOUT_MS");
  });

  it("should apply an override to its own role only and leave the others inheriting", () => {
    // When
    const roles = resolveRoles(BASE, {
      [GenerationRole.ANNOTATE]: { model: "small-4b", timeoutMs: 30_000 },
    });

    // Then
    expect(roles[GenerationRole.ANNOTATE]).toMatchObject({
      model: "small-4b",
      timeoutMs: 30_000,
      url: "http://host/api/chat",
      timeoutKnob: "consolidation.roles.annotate.timeoutMs",
    });
    expect(roles[GenerationRole.ANNOTATE].overrides).toEqual(["model", "timeoutMs"]);
    expect(roles[GenerationRole.GENERATE].model).toBe("big-12b");
    expect(roles[GenerationRole.RECONCILE].model).toBe("big-12b");
  });

  it("should report which roles inherit so a swap is visible before any call is made", () => {
    // When
    const described = describeRoles(
      resolveRoles(BASE, { [GenerationRole.RECONCILE]: { url: "http://other/api/chat" } }),
    );

    // Then
    expect(described[GenerationRole.RECONCILE]).toMatchObject({
      url: "http://other/api/chat",
      model: "big-12b",
      timeout_ms: 25_000,
      inherited: false,
    });
    expect(described[GenerationRole.GENERATE]).toMatchObject({ inherited: true });
  });
});

describe("Role override parsing", () => {
  it("should accept a table naming only some roles and only some of their settings", () => {
    // When / Then
    expect(
      parseRoleOverrides('{"annotate":{"model":"small-4b"},"reconcile":{"timeoutMs":20000}}'),
    ).toEqual({ annotate: { model: "small-4b" }, reconcile: { timeoutMs: 20_000 } });
  });

  it("should reject the whole table when one entry is malformed rather than half-applying it", () => {
    // When / Then — an unknown role, an unknown setting, a non-positive or fractional
    // deadline, an empty model, and a non-object all fall back to no overrides at all.
    expect(parseRoleOverrides('{"judge":{"model":"m"}}')).toBeUndefined();
    expect(parseRoleOverrides('{"annotate":{"models":"m"}}')).toBeUndefined();
    expect(parseRoleOverrides('{"annotate":{"timeoutMs":0}}')).toBeUndefined();
    expect(parseRoleOverrides('{"annotate":{"timeoutMs":1.5}}')).toBeUndefined();
    expect(parseRoleOverrides('{"annotate":{"model":"  "}}')).toBeUndefined();
    expect(parseRoleOverrides('["annotate"]')).toBeUndefined();
    expect(parseRoleOverrides("not json")).toBeUndefined();
  });
});

describe("Role overrides in configuration", () => {
  it("should read the table from MEMORY_CONSOLIDATE_ROLES", () => {
    // Given
    const config = new ConsolidationConfig(
      new StaticConfigSource({
        MEMORY_CONSOLIDATE_ROLES: '{"annotate":{"model":"small-4b"}}',
      }),
    );

    // When / Then
    expect(config.roles).toEqual({ annotate: { model: "small-4b" } });
    expect(resolveRoles(config, config.roles)[GenerationRole.ANNOTATE].model).toBe("small-4b");
  });

  it("should default to no overrides, so a config naming no role behaves as one model", () => {
    // Given
    const config = new ConsolidationConfig(new StaticConfigSource({}));

    // When
    const roles = resolveRoles(config, config.roles);

    // Then
    expect(config.roles).toEqual({});
    expect(roles[GenerationRole.GENERATE].model).toBe(config.model);
    expect(roles[GenerationRole.ANNOTATE].model).toBe(config.model);
    expect(roles[GenerationRole.RECONCILE].timeoutMs).toBe(config.reconcileTimeoutMs);
  });

  it("should record an unparseable table as ignored instead of failing to start", () => {
    // Given
    const config = new ConsolidationConfig(
      new StaticConfigSource({ MEMORY_CONSOLIDATE_ROLES: '{"annotate":' }),
    );

    // When / Then
    expect(config.roles).toEqual({});
  });
});

describe("HTTP provider role routing", () => {
  it("should send each role to its own model and host", async () => {
    // Given
    const sent: Sent[] = [];
    const provider = new HttpConsolidator({
      roles: resolveRoles(BASE, {
        [GenerationRole.ANNOTATE]: { model: "small-4b" },
        [GenerationRole.RECONCILE]: { model: "small-4b", url: "http://local/api/chat" },
      }),
      fetchFn: recorder(sent),
    });

    // When
    await provider.generate(TASK);
    await provider.reconcile(RECONCILE_TASK);
    await provider.annotate(ANNOTATE_TASK);

    // Then
    expect(sent).toEqual([
      { url: "http://host/api/chat", model: "big-12b" },
      { url: "http://local/api/chat", model: "small-4b" },
      { url: "http://host/api/chat", model: "small-4b" },
    ]);
  });

  it("should name the role, its model and the knob that raises it when a call times out", async () => {
    // Given
    const provider = new HttpConsolidator({
      roles: resolveRoles(BASE, {
        [GenerationRole.RECONCILE]: { model: "small-4b", timeoutMs: 1 },
      }),
      fetchFn: recorder([], true),
    });

    // When / Then
    await expect(provider.reconcile(RECONCILE_TASK)).rejects.toThrow(
      /reconcile on small-4b timed out after 1ms \(consolidation\.roles\.reconcile\.timeoutMs\)/,
    );
  });

  it("should fall back to the flat settings for every role when none are resolved", async () => {
    // Given — how a directly-constructed adapter (a script, a test) is built.
    const sent: Sent[] = [];
    const provider = new HttpConsolidator({
      url: "http://flat/api/chat",
      model: "flat-model",
      fetchFn: recorder(sent),
    });

    // When
    await provider.annotate(ANNOTATE_TASK);

    // Then
    expect(sent).toEqual([{ url: "http://flat/api/chat", model: "flat-model" }]);
  });
});

describe("Command provider role routing", () => {
  it("should tell the user process which model the role resolved to", async () => {
    // Given
    const seen: string[] = [];
    const provider = new CommandConsolidator({
      roles: resolveRoles(BASE, { [GenerationRole.ANNOTATE]: { model: "small-4b" } }),
      runner: (input) => {
        seen.push((JSON.parse(input) as { model: string }).model);

        return Promise.resolve(JSON.stringify(REPLY));
      },
    });

    // When
    await provider.generate(TASK);
    await provider.annotate(ANNOTATE_TASK);

    // Then
    expect(seen).toEqual(["big-12b", "small-4b"]);
  });
});
