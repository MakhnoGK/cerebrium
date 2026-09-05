import { describe, expect, it } from "vitest";
import { DENIED_TOOLS } from "@/runtime/agent-run";
import { AGENT_JOB_PREFIX, JobKind } from "@/core/vocab";
import { candidateQuery, parseReply, RECURRING_TASKS, TASK_KINDS, taskFor } from "@/runner/tasks";

describe("agent task registry", () => {
  it("should namespace every task under the agent prefix the daemon refuses to claim", () => {
    // Given / When / Then
    for (const kind of TASK_KINDS) expect(kind.startsWith(AGENT_JOB_PREFIX)).toBe(true);
  });

  it("should resolve a known kind and nothing else", () => {
    // Given / When / Then
    expect(taskFor(JobKind.AGENT_SELFTEST)).toBeDefined();
    expect(taskFor("agent.invented")).toBeUndefined();
    expect(taskFor(JobKind.CODE_INDEX)).toBeUndefined();
  });

  it("should give every task an explicit model, budget and wall clock", () => {
    // Given / When / Then
    for (const kind of TASK_KINDS) {
      const task = taskFor(kind)!;

      expect(task.model.length).toBeGreaterThan(0);
      expect(task.maxBudgetUsd).toBeGreaterThan(0);
      expect(task.timeoutMs).toBeGreaterThan(0);
    }
  });

  it("should never pre-approve a tool the runner refuses outright", () => {
    // Given / When / Then
    for (const kind of TASK_KINDS) {
      for (const tool of taskFor(kind)!.allowedTools) {
        expect(DENIED_TOOLS).not.toContain(tool);
      }
    }
  });

  it("should grant a read-only task no writing tool", () => {
    // Given
    const writing = /write|update|invalidate|restore|link|checkpoint|apply|upsert|register|index/i;

    // When / Then
    for (const kind of TASK_KINDS) {
      const task = taskFor(kind)!;

      if (task.writes) continue;

      for (const tool of task.allowedTools) expect(tool).not.toMatch(writing);
    }
  });

  it("should build the selftest prompt without reaching for memory, so it can run on an empty store", async () => {
    // Given
    const task = taskFor(JobKind.AGENT_SELFTEST)!;
    const call = () => Promise.reject(new Error("the selftest must not read"));

    // When
    const prompt = await task.prompt({ call }, {});

    // Then
    expect(prompt).toContain("session_start");
    expect(prompt).toContain("Do not write");
    expect(task.writes).toBe(false);
  });
});

describe("selftest result verification", () => {
  const verify = (r: string | null) => taskFor(JobKind.AGENT_SELFTEST)!.verify(r);

  it("should accept a reply carrying a real session id", () => {
    // Given / When / Then
    expect(verify('{"session":"01M0SC2N7PZBQ7JE7VY7AQ5YAQ","hits":1}')).toBeNull();
  });

  it("should accept the same reply inside a code fence", () => {
    // Given / When / Then
    expect(verify('```json\n{"session":"01M0SC2N7PZBQ7JE7VY7AQ5YAQ","hits":1}\n```')).toBeNull();
  });

  it("should reject the shape a run produces when it never reached the tools", () => {
    // Given — exactly what the first live self-test returned, having exited 0.
    const real = '{"session":"session_start tool not available via ToolSearch","hits":0}';

    // When / Then
    expect(verify(real)).toContain("session is not an id");
  });

  it("should reject a reply with no session at all, and an empty one", () => {
    // Given / When / Then
    expect(verify("I could not do that.")).toBe("no session in the reply");
    expect(verify(null)).toBe("no reply");
  });
});

describe("the documents task", () => {
  const task = () => taskFor(JobKind.AGENT_DOCUMENTS)!;

  const hits = (n: number) => ({
    results: Array.from({ length: n }, (_, i) => ({
      id: `01M0SC2N7PZBQ7JE7VY7AQ5Y${String(i).padStart(2, "0")}`,
      title: `note ${String(i)}`,
    })),
  });

  it("should build its prompt from notes the store actually holds", async () => {
    // Given
    const asked: { name: string; args: Record<string, unknown> }[] = [];
    const call = (name: string, args: Record<string, unknown>) => {
      asked.push({ name, args });

      return Promise.resolve(hits(2));
    };

    // When
    const prompt = await task().prompt({ call }, {});

    // Then
    expect(asked[0]!.name).toBe("search_memory");
    expect(asked[0]!.args.types).toEqual(["fact", "howto", "decision"]);
    expect(prompt).toContain("01M0SC2N7PZBQ7JE7VY7AQ5Y00");
    expect(prompt).toContain("note 1");
  });

  it("should refuse to spawn a run it has no candidates for, rather than pay for a shrug", async () => {
    // Given
    const call = () => Promise.resolve({ results: [] });

    // When / Then
    await expect(task().prompt({ call }, {})).rejects.toThrow(/no candidate notes/);
  });

  it("should be allowed to link and nothing else that changes content", () => {
    // Given / When
    const tools = task().allowedTools;

    // Then
    expect(tools).toContain("mcp__cerebrium__link");
    expect(tools).not.toContain("mcp__cerebrium__write");
    expect(tools).not.toContain("mcp__cerebrium__update");
    expect(tools).not.toContain("mcp__cerebrium__invalidate");
    expect(task().writes).toBe(true);
  });

  it("should be the task the loop schedules for itself", () => {
    // Given / When / Then
    expect(RECURRING_TASKS.map((t) => t.kind)).toContain(JobKind.AGENT_DOCUMENTS);
    expect(RECURRING_TASKS.map((t) => t.kind)).not.toContain(JobKind.AGENT_SELFTEST);
    for (const t of RECURRING_TASKS) expect(t.everyMs).toBeGreaterThan(0);
  });
});

describe("documents result verification", () => {
  const verify = (r: string | null) => taskFor(JobKind.AGENT_DOCUMENTS)!.verify(r);
  const SESSION = "01M0SC2N7PZBQ7JE7VY7AQ5YAQ";
  const SYMBOL = "01M0SBN52CMG811MZ4XZ5DTP64";

  it("should accept a run that linked what it says it linked", () => {
    // Given / When / Then
    expect(
      verify(
        `{"session":"${SESSION}","note":"${SESSION}","edges":[{"symbol":"${SYMBOL}","why":"x"}]}`,
      ),
    ).toBeNull();
  });

  it("should accept finding nothing, which is a real answer and not a failure", () => {
    // Given / When / Then
    expect(verify(`{"session":"${SESSION}","note":"${SESSION}","edges":[]}`)).toBeNull();
  });

  it("should reject a reply that never got as far as deciding", () => {
    // Given / When / Then — no edges key at all is not the same as an empty one.
    expect(verify(`{"session":"${SESSION}","note":"${SESSION}"}`)).toBe(
      "no edges list in the reply",
    );
  });

  it("should reject an edge that names no symbol id, which is how a made-up link reads", () => {
    // Given / When / Then
    expect(
      verify(`{"session":"${SESSION}","edges":[{"symbol":"the CallPipeline class","why":"x"}]}`),
    ).toContain("names no symbol id");
  });

  it("should reject a run that reports more edges than it was allowed to draw", () => {
    // Given
    const four = Array.from({ length: 4 }, () => `{"symbol":"${SYMBOL}","why":"x"}`).join(",");

    // When / Then
    expect(verify(`{"session":"${SESSION}","edges":[${four}]}`)).toContain("cap is 3");
  });
});

describe("reading the model's reply", () => {
  it("should survive a fenced object carrying a nested array", () => {
    // Given
    const fenced = '```json\n{"session":"x","edges":[{"symbol":"y"}]}\n```';

    // When / Then — the old flat-object regex could not span the inner braces.
    expect(parseReply(fenced)).toEqual({ session: "x", edges: [{ symbol: "y" }] });
  });

  it("should ignore prose the model wrapped around the object", () => {
    // Given / When / Then
    expect(parseReply('Here you go: {"session":"x","edges":[]} — hope that helps.')).toEqual({
      session: "x",
      edges: [],
    });
  });

  it("should report nothing when there is no object at all", () => {
    // Given / When / Then
    expect(parseReply("I could not do that.")).toBeNull();
    expect(parseReply("")).toBeNull();
  });
});

describe("spreading the documents task over the store", () => {
  it("should ask a different thing on consecutive days", () => {
    // Given / When / Then — a fixed query pins the candidate set, and the model then works
    // the same note every run.
    expect(candidateQuery(0)).not.toBe(candidateQuery(1));
    expect(candidateQuery(1)).not.toBe(candidateQuery(2));
  });

  it("should come back round rather than run out", () => {
    // Given
    const seen = new Set(Array.from({ length: 40 }, (_, day) => candidateQuery(day)));

    // When / Then
    expect(seen.size).toBeGreaterThan(1);
    expect(candidateQuery(0)).toBe(candidateQuery(seen.size));
  });

  it("should never index out of the list, whatever the day number", () => {
    // Given / When / Then — a clock skewed before the epoch yields a negative day.
    for (const day of [-1, -7, -1000, 0, 999999]) {
      expect(typeof candidateQuery(day)).toBe("string");
      expect(candidateQuery(day).length).toBeGreaterThan(0);
    }
  });

  it("should tell the run to leave an already-covered note alone", async () => {
    // Given
    const call = () =>
      Promise.resolve({ results: [{ id: "01M0SC2N7PZBQ7JE7VY7AQ5YAQ", title: "a note" }] });

    // When
    const prompt = await taskFor(JobKind.AGENT_DOCUMENTS)!.prompt({ call }, {});

    // Then
    expect(prompt).toContain("NO `documents` edge yet");
  });
});
