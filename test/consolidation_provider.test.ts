import { describe, it, expect, afterEach } from "vitest";
import { createConsolidator } from "@/consolidation/index";
import {
  annotationFtsText,
  parseAnnotate,
  parseReconcile,
  parseResult,
  reconcilePrompt,
  taskPrompt,
  type AnnotateTask,
  type ConsolidationTask,
  type ReconcileTask,
} from "@/consolidation/provider";
import { HttpConsolidator, type FetchFn } from "@/consolidation/http";
import { CommandConsolidator } from "@/consolidation/command";

const TASK: ConsolidationTask = {
  kind: "distill",
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

describe("createConsolidator — env selection", () => {
  it("defaults to the manual provider (offline, not enabled)", () => {
    const p = createConsolidator();
    expect(p.name).toBe("manual");
    expect(p.enabled).toBe(false);
  });

  it("selects off / http / command by name with correct enabled flags", () => {
    expect(createConsolidator("off")).toMatchObject({ name: "off", enabled: false });
    expect(createConsolidator("http")).toMatchObject({ name: "http", enabled: true });
    expect(createConsolidator("command")).toMatchObject({ name: "command", enabled: true });
  });

  it("reads MEMORY_CONSOLIDATE when no name is passed", () => {
    process.env.MEMORY_CONSOLIDATE = "http";
    expect(createConsolidator().name).toBe("http");
  });
});

describe("manual / off never generate", () => {
  it("manual.generate rejects with an actionable message", async () => {
    await expect(createConsolidator("manual").generate(TASK)).rejects.toThrow(/agent authors/);
  });
  it("off.generate rejects", async () => {
    await expect(createConsolidator("off").generate(TASK)).rejects.toThrow(/off/);
  });
  it("manual / off also reject reconcile", async () => {
    await expect(createConsolidator("manual").reconcile(RECONCILE_TASK)).rejects.toThrow(
      /agent decides/,
    );
    await expect(createConsolidator("off").reconcile(RECONCILE_TASK)).rejects.toThrow(/off/);
  });
  it("manual / off also reject annotate", async () => {
    await expect(createConsolidator("manual").annotate(ANNOTATE_TASK)).rejects.toThrow(
      /does not annotate/,
    );
    await expect(createConsolidator("off").annotate(ANNOTATE_TASK)).rejects.toThrow(/off/);
  });
});

describe("parseAnnotate + annotationFtsText", () => {
  it("keeps string members, drops non-strings, folds into one FTS blob", () => {
    const a = parseAnnotate(
      '{"keywords":["resilience",42,"failover"],"tags":["infra"],"context":"survives an outage"}',
    );
    expect(a).toEqual({
      keywords: ["resilience", "failover"],
      tags: ["infra"],
      context: "survives an outage",
    });
    const text = annotationFtsText(a);
    expect(text).toContain("resilience");
    expect(text).toContain("infra");
    expect(text).toContain("survives an outage");
  });
  it("degrades a non-array / non-string reply to empty attributes", () => {
    expect(parseAnnotate('{"keywords":"nope","context":5}')).toEqual({
      keywords: [],
      tags: [],
      context: "",
    });
  });
  it("rejects invalid JSON", () => {
    expect(() => parseAnnotate("not json")).toThrow(/invalid JSON/);
  });
});

describe("parseReconcile", () => {
  it("accepts a well-formed verdict", () => {
    expect(parseReconcile('{"action":"update","target_id":"01ABC","reason":"refines it"}')).toEqual(
      {
        action: "update",
        target_id: "01ABC",
        reason: "refines it",
      },
    );
  });
  it("degrades an unknown action to noop and a non-string target to null", () => {
    expect(parseReconcile('{"action":"frobnicate","target_id":42,"reason":"x"}')).toEqual({
      action: "noop",
      target_id: null,
      reason: "x",
    });
  });
  it("rejects invalid JSON", () => {
    expect(() => parseReconcile("not json")).toThrow(/invalid JSON/);
  });
});

describe("reconcilePrompt", () => {
  it("includes the draft and labels each candidate by id", () => {
    const p = reconcilePrompt(RECONCILE_TASK);
    expect(p).toContain("project: billing");
    expect(p).toContain("tokens expire in 15 minutes");
    expect(p).toContain("[01ABC] Token TTL");
  });
});

describe("parseResult", () => {
  it("accepts a well-formed result", () => {
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
  it("defaults recommendation to apply when the field is absent", () => {
    expect(parseResult('{"title":"T","summary":"S","body":"B"}')).toMatchObject({
      recommendation: "apply",
      title: "T",
    });
  });
  it("rejects invalid JSON and missing fields", () => {
    expect(() => parseResult("not json")).toThrow(/invalid JSON/);
    expect(() => parseResult('{"title":"T"}')).toThrow(/missing/);
  });
});

describe("taskPrompt", () => {
  it("labels each record and names the project", () => {
    const p = taskPrompt(TASK);
    expect(p).toContain("project: cerebrium");
    expect(p).toContain("[1] First");
    expect(p).toContain("[2] Second");
    expect(p).toContain("splitting it made it fast");
  });
});

describe("HttpConsolidator (injected fetch)", () => {
  it("posts a structured-output request and parses message.content", async () => {
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
    const out = await p.generate(TASK);
    expect(out).toMatchObject({ title: "T", summary: "S", body: "B" });
    const body = captured!.body as Record<string, unknown>;
    expect(captured!.url).toBe("http://x/api/chat");
    expect(body.model).toBe("m");
    expect(body.stream).toBe(false);
    expect(body.format).toBeDefined();
    expect((body.messages as { role: string }[])[0]!.role).toBe("system");
  });

  it("throws on non-2xx and on a missing content field (-> caller degrades)", async () => {
    const bad: FetchFn = () => Promise.resolve(new Response("", { status: 503 }));
    await expect(new HttpConsolidator({ fetchFn: bad }).generate(TASK)).rejects.toThrow(/HTTP 503/);

    const empty: FetchFn = () => Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    await expect(new HttpConsolidator({ fetchFn: empty }).generate(TASK)).rejects.toThrow(
      /message\.content/,
    );
  });

  it("reconcile posts the reconcile schema and parses the verdict", async () => {
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
    const out = await new HttpConsolidator({ fetchFn }).reconcile(RECONCILE_TASK);
    expect(out).toMatchObject({ action: "update", target_id: "01ABC" });
    const props = (captured!.body.format as { properties: Record<string, unknown> }).properties;
    expect(props.action).toBeDefined();
  });

  it("annotate posts the annotate schema and parses attributes", async () => {
    const fetchFn: FetchFn = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            message: { content: '{"keywords":["a"],"tags":["b"],"context":"c"}' },
          }),
          { status: 200 },
        ),
      );
    const out = await new HttpConsolidator({ fetchFn }).annotate(ANNOTATE_TASK);
    expect(out).toEqual({ keywords: ["a"], tags: ["b"], context: "c" });
  });
});

describe("CommandConsolidator (injected runner)", () => {
  it("feeds the task on stdin and parses stdout", async () => {
    let stdin = "";
    const p = new CommandConsolidator({
      runner: (input) => {
        stdin = input;
        return Promise.resolve('{"title":"T","summary":"S","body":"B"}');
      },
    });
    const out = await p.generate(TASK);
    expect(out).toMatchObject({ title: "T", summary: "S", body: "B" });
    const sent = JSON.parse(stdin) as { kind: string; inputs: unknown[] };
    expect(sent.kind).toBe("distill");
    expect(sent.inputs).toHaveLength(2);
  });

  it("propagates a runner failure and rejects malformed stdout", async () => {
    const boom = new CommandConsolidator({
      runner: () => Promise.reject(new Error("exit 1")),
    });
    await expect(boom.generate(TASK)).rejects.toThrow(/exit 1/);

    const junk = new CommandConsolidator({ runner: () => Promise.resolve("nope") });
    await expect(junk.generate(TASK)).rejects.toThrow(/invalid JSON/);
  });

  it("reconcile tags the payload with task='reconcile' and parses the verdict", async () => {
    let stdin = "";
    const p = new CommandConsolidator({
      runner: (input) => {
        stdin = input;
        return Promise.resolve('{"action":"noop","target_id":null,"reason":"distinct"}');
      },
    });
    const out = await p.reconcile(RECONCILE_TASK);
    expect(out).toMatchObject({ action: "noop", target_id: null });
    const sent = JSON.parse(stdin) as { task: string; candidates: unknown[] };
    expect(sent.task).toBe("reconcile");
    expect(sent.candidates).toHaveLength(1);
  });

  it("annotate tags the payload with task='annotate' and parses attributes", async () => {
    let stdin = "";
    const p = new CommandConsolidator({
      runner: (input) => {
        stdin = input;
        return Promise.resolve('{"keywords":["a"],"tags":[],"context":"c"}');
      },
    });
    const out = await p.annotate(ANNOTATE_TASK);
    expect(out).toEqual({ keywords: ["a"], tags: [], context: "c" });
    const sent = JSON.parse(stdin) as { task: string; title: string };
    expect(sent.task).toBe("annotate");
    expect(sent.title).toBe("Failover behavior");
  });
});
