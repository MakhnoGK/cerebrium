import { aggregateAudits, auditTranscript } from "@scripts/agent-trace-audit";
import { describe, expect, it } from "vitest";

function row(step: number, toolCalls: unknown[], truncated = false): string {
  return JSON.stringify({
    step_index: step,
    type: "PLANNER_RESPONSE",
    tool_calls: toolCalls,
    ...(truncated ? { truncated_fields: ["tool_calls"] } : {}),
  });
}

function mcp(name: string, args: Record<string, unknown>): unknown {
  return {
    name: "call_mcp_tool",
    args: {
      ServerName: JSON.stringify("cerebrium"),
      ToolName: JSON.stringify(name),
      Arguments: JSON.stringify(args),
    },
  };
}

describe("auditTranscript", () => {
  it("should count only strictly earlier search and code lookup as precedence", () => {
    // Given
    const trace = [
      row(0, [mcp("session_start", {})]),
      row(1, [mcp("search", {}), mcp("write", { parent_node_id: "opaque", links: [{}] })]),
      row(2, [mcp("code_lookup", {}), { name: "view_file", args: {} }]),
    ].join("\n");

    // When
    const audit = auditTranscript(trace);

    // Then
    expect(audit.lifecycle).toBe("yes");
    expect(audit.searchBeforeWrite).toEqual({ yes: 0, no: 0, unknown: 1 });
    expect(audit.codeLookupBeforeFileNavigation).toBe("unknown");
    expect(audit.writes.parentAttached).toBe(1);
    expect(audit.writes.inlineLinks).toBe(1);
  });

  it("should mark truncated tool calls partial and skip their arguments", () => {
    // Given
    const trace = row(1, [mcp("write", { parent_node_id: "opaque" })], true);

    // When
    const audit = auditTranscript(trace);

    // Then
    expect(audit.observability).toBe("partial");
    expect(audit.writes.observed).toBe(1);
    expect(audit.writes.argumentsObservable).toBe(0);
    expect(audit.writes.parentAttached).toBe(0);
  });

  it("should fail closed on malformed encoded MCP fields", () => {
    // Given
    const trace = row(0, [
      {
        name: "call_mcp_tool",
        args: { ServerName: '"cerebrium', ToolName: JSON.stringify("search"), Arguments: "{}" },
      },
    ]);

    // When / Then
    expect(auditTranscript(trace).observability).toBe("partial");
  });

  it("should make negative ordering unknown when an earlier row is truncated", () => {
    // Given
    const trace = [
      row(0, [mcp("get", {})], true),
      row(1, [mcp("write", { parent_node_id: null })]),
      row(2, [{ name: "view_file", args: {} }]),
    ].join("\n");

    // When
    const audit = auditTranscript(trace);

    // Then
    expect(audit.observability).toBe("partial");
    expect(audit.lifecycle).toBe("unknown");
    expect(audit.searchBeforeWrite).toEqual({ yes: 0, no: 0, unknown: 1 });
    expect(audit.codeLookupBeforeFileNavigation).toBe("unknown");
  });

  it("should distinguish an unobservable trace from an observed empty tool-call schema", () => {
    // Given / When
    const missingSchema = auditTranscript(JSON.stringify({ type: "PLANNER_RESPONSE" }));
    const emptySchema = auditTranscript(row(0, []));

    // Then
    expect(missingSchema.observability).toBe("unobservable");
    expect(missingSchema.lifecycle).toBe("unknown");
    expect(emptySchema.observability).toBe("complete");
    expect(emptySchema.lifecycle).toBe("not-applicable");
  });

  it("should exclude host-owned tool output files from code navigation", () => {
    // Given
    const trace = [
      row(0, [mcp("session_start", {})]),
      row(1, [
        {
          name: "view_file",
          args: {
            AbsolutePath: JSON.stringify("/tmp/brain/.system_generated/steps/1/output.txt"),
          },
        },
      ]),
      row(2, [mcp("code_lookup", {})]),
    ].join("\n");

    // When / Then
    expect(auditTranscript(trace).codeLookupBeforeFileNavigation).toBe("not-applicable");
  });

  it("should aggregate partial histories as lower bounds without a verdict", () => {
    // Given
    const complete = auditTranscript(row(0, [mcp("session_start", {})]));
    const partial = auditTranscript(row(1, [mcp("checkpoint", {})], true));

    // When
    const aggregate = aggregateAudits([complete, partial]);

    // Then
    expect(aggregate.mode).toBe("historical");
    expect(aggregate.totalsAreLowerBounds).toBe(true);
    expect(aggregate.complete).toBe(1);
    expect(aggregate.partial).toBe(1);
    expect(aggregate.unobservable).toBe(0);
  });
});
