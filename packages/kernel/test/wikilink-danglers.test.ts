import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryKind } from "@cerebrium/contracts/vocab";
import type { WikilinkDangler, WikilinkFixResult } from "@cerebrium/contracts/wikilinks";
import { CallPipeline } from "@/application/call-pipeline";
import { setup, type TestEnv } from "@test/helpers";

let env: TestEnv;
let session: string;

function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  return container.resolve(CallPipeline).invoke(container, name, args, {
    client: "cerebrium-dashboard",
    version: null,
  }) as Promise<T>;
}

async function note(
  title: string,
  content: string,
  project: string | null = "cerebrium",
  kind = MemoryKind.SEMANTIC,
): Promise<string> {
  const written = await call<{ envelope: { id: string } }>("write_memory", {
    session_id: session,
    parent_node_id: null,
    memory_kind: kind,
    type: kind === MemoryKind.SEMANTIC ? "fact" : "event_note",
    title,
    content,
    project,
  });

  return written.envelope.id;
}

function danglers(): Promise<WikilinkDangler[]> {
  return call("list_danglers", {});
}

function fix(args: Record<string, unknown>): Promise<WikilinkFixResult> {
  return call("fix_wikilink", { session_id: session, ...args });
}

async function body(id: string): Promise<string> {
  return (await env.nodes.stateAt(id, "9999-12-31T00:00:00.000Z"))!.content;
}

beforeEach(async () => {
  env = setup();
  session = (await call<{ session_id: string }>("start_session", {})).session_id;
});

describe("Listing dangling wikilinks", () => {
  it("should list a link to no note with text matches from the same project family", async () => {
    // Given
    const target = await note(
      "Episode purchase flow",
      "buying an episode works with coins, not a store purchase",
      "toonspace-builder",
    );
    await note("Coins elsewhere", "buying works with coins in another project", "cerebrium");
    const source = await note("Shop notes", "see [[How buying works]] for detail", "toonspace");

    // When
    const listed = await danglers();

    // Then
    expect(listed).toEqual([
      {
        node_id: source,
        node_title: "Shop notes",
        project: "toonspace",
        link: "How buying works",
        reason: "unknown",
        editable: true,
        suggestions: [{ id: target, title: "Episode purchase flow" }],
      },
    ]);
  });

  it("should offer every note an ambiguous link could mean", async () => {
    // Given
    const a = await note("Retry budget", "the client retries three times");
    const b = await note("Retry budget", "the worker retries five times");
    await note("Plan", "builds on [[Retry budget]]");

    // When
    const [dangler] = await danglers();

    // Then
    expect(dangler?.reason).toBe("ambiguous");
    expect(dangler?.suggestions.map((s) => s.id).sort()).toEqual([a, b].sort());
  });

  it("should resolve a link written against a renamed note's old title", async () => {
    // Given
    const renamed = await note("Old name", "a fact that will be renamed");
    await note("Plan", "builds on [[Old name]]");
    await call("update_memory", { session_id: session, id: renamed, title: "New name" });

    // When / Then
    expect(await danglers()).toEqual([]);
  });
});

describe("Fixing dangling wikilinks", () => {
  it("should point the link at the chosen note by id", async () => {
    // Given
    const target = await note("Episode purchase flow", "coins buy an episode");
    const source = await note(
      "Shop notes",
      "see [[How buying works]] and [[How buying works|this]]",
    );

    // When
    const result = await fix({
      node_id: source,
      link: "How buying works",
      action: "rewrite",
      target_id: target,
    });

    // Then
    expect(result).toEqual({ node_id: source, action: "rewrite", rewritten: 2 });
    expect(await body(source)).toBe(`see [[${target}]] and [[${target}|this]]`);
    expect(await danglers()).toEqual([]);
    expect((await env.nodes.listRevisions(source)).at(-1)?.reason).toBe(
      `wikilink [[How buying works]] -> [[${target}]] (dashboard)`,
    );
  });

  it("should unlink, keeping the text", async () => {
    // Given
    const source = await note("Shop notes", "see [[How buying works]] for detail");

    // When
    await fix({ node_id: source, link: "How buying works", action: "unlink" });

    // Then
    expect(await body(source)).toBe("see How buying works for detail");
    expect(await danglers()).toEqual([]);
  });

  it("should stop listing a link the owner ignored", async () => {
    // Given
    const source = await note("Shop notes", "see [[How buying works]] for detail");

    // When
    await fix({ node_id: source, link: "How buying works", action: "ignore" });

    // Then
    expect(await danglers()).toEqual([]);
    expect(await body(source)).toBe("see [[How buying works]] for detail");
  });

  it("should leave an episodic note's text alone and only let its link be ignored", async () => {
    // Given
    const target = await note("Episode purchase flow", "coins buy an episode");
    const record = await note(
      "Block closed",
      "followed [[How buying works]]",
      "cerebrium",
      MemoryKind.EPISODIC,
    );

    // When
    const [dangler] = await danglers();
    const rewrite = fix({
      node_id: record,
      link: "How buying works",
      action: "rewrite",
      target_id: target,
    });

    // Then
    expect(dangler?.editable).toBe(false);
    await expect(rewrite).rejects.toThrow(/write-once/);
    await fix({ node_id: record, link: "How buying works", action: "ignore" });
    expect(await danglers()).toEqual([]);
  });
});
