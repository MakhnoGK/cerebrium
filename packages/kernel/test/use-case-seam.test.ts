import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import {
  RETRY_CANDIDATE,
  SEARCH_MEMORY,
  type RetryCandidate,
  type SearchOutcome,
} from "@/application/use-cases";
import { ConsolidateRetryTool } from "@/presentation/mcp/tools/consolidate-retry";
import { SearchTool } from "@/presentation/mcp/tools/search";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { setup, type TestEnv } from "@test/helpers";

const ID = "01JJJJJJJJJJJJJJJJJJJJJJJJ";

let env: TestEnv;

beforeEach(() => {
  env = setup();
});

// A stand-in that touches no database at all, registered in a child scope so it cannot
// leak into the next test. If a tool goes back to injecting a repo the substitution stops
// being observable and this fails — which is the whole point of addressing a use case by
// token rather than by class.
function stubbed<Args, Result>(result: Result) {
  const calls: Args[] = [];
  const scope = container.createChildContainer();

  scope.register(RETRY_CANDIDATE, {
    useValue: {
      invoke(args: Args) {
        calls.push(args);

        return Promise.resolve(result);
      },
    } as RetryCandidate,
  });

  return { calls, scope };
}

function failedCandidate(id: string): void {
  env.db
    .prepare(
      `INSERT INTO consolidation_candidates
         (id, kind, status, member_ids, member_hash, score, proposal, detected_at, last_error)
       VALUES (?, 'merge', 'failed', '[]', ?, 0.9, '{}', ?, 'provider timed out')`,
    )
    .run(id, id, "2026-01-01T00:00:00.000Z");
}

describe("The use-case seam", () => {
  it("should let a stand-in implementation replace the local one", async () => {
    // Given
    const { calls, scope } = stubbed<{ id: string }, unknown>({ status: "reopened", id: ID });

    // When
    const result = await scope
      .resolve(ConsolidateRetryTool)
      .invoke({ session_id: ID, id: "01KKKKKKKKKKKKKKKKKKKKKKKK" });

    // Then
    expect(calls).toEqual([{ id: "01KKKKKKKKKKKKKKKKKKKKKKKK" }]);
    expect(result).toEqual({ status: "reopened", id: ID });
  });

  it("should reopen a real candidate through the local implementation", async () => {
    // Given
    failedCandidate(ID);

    // When
    await container.resolve(ConsolidateRetryTool).invoke({ session_id: ID, id: ID });

    // Then
    const row = env.db
      .prepare(
        "SELECT status, attempts, proposal, last_error FROM consolidation_candidates WHERE id = ?",
      )
      .get(ID);
    expect(row).toEqual({ status: "pending", attempts: 2, proposal: null, last_error: null });
  });

  it("should route the search tool through the use case rather than the ranking model", async () => {
    // Given
    const calls: unknown[] = [];
    const outcome: SearchOutcome = {
      results: [],
      total_matches: 7,
      notes: ["a note"],
      audit: { mode: "hybrid", query: "q", results: 0, ids: [], matched: [], folded: [] },
    };
    const scope = container.createChildContainer();
    scope.register(SEARCH_MEMORY, {
      useValue: {
        invoke(args: unknown) {
          calls.push(args);

          return Promise.resolve(outcome);
        },
      },
    });

    // When
    const { session_id } = await container.resolve(SessionStartTool).invoke({});
    const result = await scope
      .resolve(SearchTool)
      .invoke({ session_id, query: "anything", limit: 3 });

    // Then — the session travels with the call, which is the only thing that lets the
    // daemon attribute the audit row to it.
    expect(calls).toEqual([{ session_id, query: "anything", limit: 3 }]);
    expect(result).toMatchObject({ total_matches: 7, context_notes: ["a note"] });
  });
});
