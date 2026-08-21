import { afterEach, describe, expect, it } from "vitest";
import type {
  AnnotateTask,
  ConsolidationTask,
  ReconcileTask,
} from "@/domain/ports/consolidation-provider";
import { CommandConsolidator } from "@/consolidation/command";
import { HttpConsolidator, type FetchFn } from "@/consolidation/http";
import {
  annotationFtsText,
  parseAnnotate,
  parseReconcile,
  parseResult,
  reconcilePrompt,
  taskPrompt,
} from "@/consolidation/provider";
import { ConsolidationKind } from "@/core/vocab";
import { createConsolidator } from "@/consolidation";
import { ConsolidationConfig, StaticConfigSource } from "@/infrastructure/config";

const TASK: ConsolidationTask = {
  kind: ConsolidationKind.DISTILL,
  project: "cerebrium",
  inputs: [
    { id: "a", title: "First", content: "the pipeline was slow" },
    { id: "b", title: "Second", content: "splitting it made it fast" },
  ],
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

afterEach(() => {
  delete process.env.MEMORY_CONSOLIDATE;
});

describe("Consolidator environment selection", () => {
  it("should default to the manual provider when no name or env is set", () => {
    // Given / When
    const p = createConsolidator();

    // Then
    expect(p.name).toBe("manual");
    expect(p.enabled).toBe(false);
  });

  it("should select off, http, or command with the correct enabled flag when named explicitly", () => {
    // When / Then
    expect(createConsolidator("off")).toMatchObject({ name: "off", enabled: false });
    expect(createConsolidator("http")).toMatchObject({ name: "http", enabled: true });
    expect(createConsolidator("command")).toMatchObject({ name: "command", enabled: true });
  });

  it("should take the provider name from configuration, not from the ambient environment", () => {
    // Given — the factory no longer reads env; the composition root passes the resolved
    // provider, so a section is what selects the backend.
    const config = new ConsolidationConfig(new StaticConfigSource({ MEMORY_CONSOLIDATE: "http" }));

    // When / Then
    expect(config.provider).toBe("http");
    expect(createConsolidator(config.provider, config).name).toBe("http");
  });

  it("should read the reconcile budget from configuration, well under the generation one", () => {
    // Given
    const defaults = new ConsolidationConfig(new StaticConfigSource({}));
    const raised = new ConsolidationConfig(
      new StaticConfigSource({ MEMORY_CONSOLIDATE_RECONCILE_TIMEOUT_MS: "40000" }),
    );

    // When / Then
    expect(defaults.reconcileTimeoutMs).toBe(25_000);
    expect(defaults.reconcileTimeoutMs).toBeLessThan(defaults.timeoutMs);
    expect(raised.reconcileTimeoutMs).toBe(40_000);
  });
});

describe("Non-generating providers (manual and off)", () => {
  it("should reject with an actionable message when the manual provider is asked to generate", async () => {
    // When / Then
    await expect(createConsolidator("manual").generate(TASK)).rejects.toThrow(/agent authors/);
  });
  it("should reject when the off provider is asked to generate", async () => {
    // When / Then
    await expect(createConsolidator("off").generate(TASK)).rejects.toThrow(/off/);
  });
  it("should reject reconcile when the provider is manual or off", async () => {
    // When / Then
    await expect(createConsolidator("manual").reconcile(RECONCILE_TASK)).rejects.toThrow(
      /agent decides/,
    );
    // When / Then
    await expect(createConsolidator("off").reconcile(RECONCILE_TASK)).rejects.toThrow(/off/);
  });
  it("should reject annotate when the provider is manual or off", async () => {
    // When / Then
    await expect(createConsolidator("manual").annotate(ANNOTATE_TASK)).rejects.toThrow(
      /does not annotate/,
    );
    // When / Then
    await expect(createConsolidator("off").annotate(ANNOTATE_TASK)).rejects.toThrow(/off/);
  });
});

describe("Annotation parsing and FTS text", () => {
  it("should keep string members, drop non-strings, and fold attributes into one FTS blob when parsing a well-formed reply", () => {
    // Given / When
    const a = parseAnnotate(
      '{"keywords":["resilience",42,"failover"],"tags":["infra"],"context":"survives an outage"}',
    );

    // Then
    expect(a).toEqual({
      keywords: ["resilience", "failover"],
      tags: ["infra"],
      context: "survives an outage",
    });

    // When / Then
    const text = annotationFtsText(a);
    expect(text).toContain("resilience");
    expect(text).toContain("infra");
    expect(text).toContain("survives an outage");
  });
  it("should degrade to empty attributes when the reply fields are not arrays or strings", () => {
    // When / Then
    expect(parseAnnotate('{"keywords":"nope","context":5}')).toEqual({
      keywords: [],
      tags: [],
      context: "",
    });
  });
  it("should throw when the reply is invalid JSON", () => {
    // When / Then
    expect(() => parseAnnotate("not json")).toThrow(/invalid JSON/);
  });
});

describe("Reconcile verdict parsing (parseReconcile)", () => {
  it("should parse the verdict when it is well-formed", () => {
    // When / Then
    expect(parseReconcile('{"action":"update","target_id":"01ABC","reason":"refines it"}')).toEqual(
      {
        action: "update",
        target_id: "01ABC",
        reason: "refines it",
      },
    );
  });
  it("should degrade an unknown action to noop and a non-string target to null", () => {
    // When / Then
    expect(parseReconcile('{"action":"frobnicate","target_id":42,"reason":"x"}')).toEqual({
      action: "noop",
      target_id: null,
      reason: "x",
    });
  });
  it("should throw when the verdict is invalid JSON", () => {
    // When / Then
    expect(() => parseReconcile("not json")).toThrow(/invalid JSON/);
  });
});

describe("Reconcile prompt building (reconcilePrompt)", () => {
  it("should include the draft and label each candidate by id when building the prompt", () => {
    // Given / When
    const p = reconcilePrompt(RECONCILE_TASK);

    // Then
    expect(p).toContain("project: billing");
    expect(p).toContain("tokens expire in 15 minutes");
    expect(p).toContain("[01ABC] Token TTL");
  });
});

describe("Consolidation result parsing (parseResult)", () => {
  it("should parse the result when it is well-formed", () => {
    // When / Then
    expect(
      parseResult(
        '{"recommendation":"reject","reason":"distinct","title":"T","summary":"S","body":"B"}',
      ),
    ).toEqual({
      recommendation: "reject",
      reason: "distinct",
      title: "T",
      summary: "S",
      body: "B",
    });
  });
  it("should default the recommendation to apply when the field is absent", () => {
    // When / Then
    expect(parseResult('{"title":"T","summary":"S","body":"B"}')).toMatchObject({
      recommendation: "apply",
      title: "T",
    });
  });
  it("should throw when the result is invalid JSON or missing required fields", () => {
    // When / Then
    expect(() => parseResult("not json")).toThrow(/invalid JSON/);
    // When / Then
    expect(() => parseResult('{"title":"T"}')).toThrow(/missing/);
  });
});

describe("Task prompt building (taskPrompt)", () => {
  it("should label each record and name the project when building the prompt", () => {
    // Given / When
    const p = taskPrompt(TASK);

    // Then
    expect(p).toContain("project: cerebrium");
    expect(p).toContain("[1] First");
    expect(p).toContain("[2] Second");
    expect(p).toContain("splitting it made it fast");
  });
});

describe("HttpConsolidator (injected fetch)", () => {
  it("should post a structured-output request and parse message.content when generating", async () => {
    // Given
    let captured: { url: string; body: unknown } | null = null;
    const fetchFn: FetchFn = (url, init) => {
      captured = { url: url as string, body: JSON.parse(init?.body as string) };
      return Promise.resolve(
        new Response(
          JSON.stringify({ message: { content: '{"title":"T","summary":"S","body":"B"}' } }),
          { status: 200 },
        ),
      );
    };
    const p = new HttpConsolidator({ url: "http://x/api/chat", model: "m", fetchFn });

    // When
    const out = await p.generate(TASK);

    // Then
    expect(out).toMatchObject({ title: "T", summary: "S", body: "B" });
    const body = captured!.body as Record<string, unknown>;
    expect(captured!.url).toBe("http://x/api/chat");
    expect(body.model).toBe("m");
    expect(body.stream).toBe(false);
    expect(body.format).toBeDefined();
    expect(body.think).toBe(false);
    expect((body.messages as { role: string }[])[0]!.role).toBe("system");
  });

  it("should retry without the reasoning flag when the backend rejects it, then stop sending it", async () => {
    // Given — a backend that 400s on `think` and answers normally without it.
    const bodies: Record<string, unknown>[] = [];
    const fetchFn: FetchFn = (_url, init) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;

      bodies.push(body);

      return Promise.resolve(
        "think" in body
          ? new Response("registry.ollama.ai/library/m does not support thinking", { status: 400 })
          : new Response(
              JSON.stringify({ message: { content: '{"title":"T","summary":"S","body":"B"}' } }),
              { status: 200 },
            ),
      );
    };
    const p = new HttpConsolidator({ fetchFn });

    // When
    const first = await p.generate(TASK);
    const second = await p.generate(TASK);

    // Then
    expect(first).toMatchObject({ title: "T" });
    expect(second).toMatchObject({ title: "T" });
    expect(bodies.map((b) => "think" in b)).toEqual([true, false, false]);
  });

  it("should surface a 400 that has nothing to do with reasoning instead of retrying it", async () => {
    // Given
    let calls = 0;
    const fetchFn: FetchFn = () => {
      calls++;

      return Promise.resolve(new Response("invalid model name", { status: 400 }));
    };

    // When / Then
    await expect(new HttpConsolidator({ fetchFn }).generate(TASK)).rejects.toThrow(
      /HTTP 400: invalid model name/,
    );
    expect(calls).toBe(1);
  });

  it("should throw when the response is non-2xx or is missing the content field", async () => {
    // Given
    const bad: FetchFn = () => Promise.resolve(new Response("", { status: 503 }));
    // When / Then
    await expect(new HttpConsolidator({ fetchFn: bad }).generate(TASK)).rejects.toThrow(/HTTP 503/);

    // Given
    const empty: FetchFn = () => Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    // When / Then
    await expect(new HttpConsolidator({ fetchFn: empty }).generate(TASK)).rejects.toThrow(
      /message\.content/,
    );
  });

  it("should carry the response body in the error when the endpoint returns non-2xx", async () => {
    // Given
    const bad: FetchFn = () =>
      Promise.resolve(new Response("model 'gemma4:12b-it-qat' not found", { status: 404 }));

    // When / Then
    await expect(new HttpConsolidator({ fetchFn: bad }).generate(TASK)).rejects.toThrow(
      /HTTP 404: model 'gemma4:12b-it-qat' not found/,
    );
  });

  it("should name the timeout rather than surface a bare abort when the request outlasts timeoutMs", async () => {
    // Given — a backend that only ever settles when the caller gives up.
    const hangs: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      });

    // When / Then
    await expect(
      new HttpConsolidator({ fetchFn: hangs, timeoutMs: 5 }).generate(TASK),
    ).rejects.toThrow(/timed out after 5ms \(MEMORY_CONSOLIDATE_TIMEOUT_MS\)/);
  });

  it("should hold reconcile to its own budget rather than the generation timeout", async () => {
    // Given — a backend that only ever settles when the caller gives up, and a generation
    // timeout far above the reconcile one.
    const hangs: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      });

    // When / Then
    await expect(
      new HttpConsolidator({
        fetchFn: hangs,
        timeoutMs: 500_000,
        reconcileTimeoutMs: 5,
      }).reconcile(RECONCILE_TASK),
    ).rejects.toThrow(/timed out after 5ms \(MEMORY_CONSOLIDATE_RECONCILE_TIMEOUT_MS\)/);
  });

  it("should post the reconcile schema and parse the verdict when reconciling", async () => {
    // Given
    let captured: { body: Record<string, unknown> } | null = null;
    const fetchFn: FetchFn = (_url, init) => {
      captured = { body: JSON.parse(init?.body as string) as Record<string, unknown> };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            message: { content: '{"action":"update","target_id":"01ABC","reason":"r"}' },
          }),
          { status: 200 },
        ),
      );
    };

    // When
    const out = await new HttpConsolidator({ fetchFn }).reconcile(RECONCILE_TASK);

    // Then
    expect(out).toMatchObject({ action: "update", target_id: "01ABC" });
    const props = (captured!.body.format as { properties: Record<string, unknown> }).properties;
    expect(props.action).toBeDefined();
  });

  it("should post the annotate schema and parse attributes when annotating", async () => {
    // Given
    const fetchFn: FetchFn = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            message: { content: '{"keywords":["a"],"tags":["b"],"context":"c"}' },
          }),
          { status: 200 },
        ),
      );

    // When
    const out = await new HttpConsolidator({ fetchFn }).annotate(ANNOTATE_TASK);

    // Then
    expect(out).toEqual({ keywords: ["a"], tags: ["b"], context: "c" });
  });
});

describe("CommandConsolidator (injected runner)", () => {
  it("should feed the task on stdin and parse stdout when generating", async () => {
    // Given
    let stdin = "";
    const p = new CommandConsolidator({
      runner: (input) => {
        stdin = input;
        return Promise.resolve('{"title":"T","summary":"S","body":"B"}');
      },
    });

    // When
    const out = await p.generate(TASK);

    // Then
    expect(out).toMatchObject({ title: "T", summary: "S", body: "B" });
    const sent = JSON.parse(stdin) as { kind: string; inputs: unknown[] };
    expect(sent.kind).toBe("distill");
    expect(sent.inputs).toHaveLength(2);
  });

  it("should propagate a runner failure and reject malformed stdout when generating", async () => {
    // Given
    const boom = new CommandConsolidator({
      runner: () => Promise.reject(new Error("exit 1")),
    });
    // When / Then
    await expect(boom.generate(TASK)).rejects.toThrow(/exit 1/);

    // Given
    const junk = new CommandConsolidator({ runner: () => Promise.resolve("nope") });
    // When / Then
    await expect(junk.generate(TASK)).rejects.toThrow(/invalid JSON/);
  });

  it("should tag the payload with task='reconcile' and parse the verdict when reconciling", async () => {
    // Given
    let stdin = "";
    const p = new CommandConsolidator({
      runner: (input) => {
        stdin = input;
        return Promise.resolve('{"action":"noop","target_id":null,"reason":"distinct"}');
      },
    });

    // When
    const out = await p.reconcile(RECONCILE_TASK);

    // Then
    expect(out).toMatchObject({ action: "noop", target_id: null });
    const sent = JSON.parse(stdin) as { task: string; candidates: unknown[] };
    expect(sent.task).toBe("reconcile");
    expect(sent.candidates).toHaveLength(1);
  });

  it("should tag the payload with task='annotate' and parse attributes when annotating", async () => {
    // Given
    let stdin = "";
    const p = new CommandConsolidator({
      runner: (input) => {
        stdin = input;
        return Promise.resolve('{"keywords":["a"],"tags":[],"context":"c"}');
      },
    });

    // When
    const out = await p.annotate(ANNOTATE_TASK);

    // Then
    expect(out).toEqual({ keywords: ["a"], tags: [], context: "c" });
    const sent = JSON.parse(stdin) as { task: string; title: string };
    expect(sent.task).toBe("annotate");
    expect(sent.title).toBe("Failover behavior");
  });
});
