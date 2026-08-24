import { describe, expect, it } from "vitest";
import { DENIED_TOOLS } from "@/runtime/agent-run";
import { AGENT_JOB_PREFIX, JobKind } from "@/core/vocab";
import { TASK_KINDS, taskFor } from "@/runner/tasks";

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
