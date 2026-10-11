import { container } from "tsyringe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKind } from "@cerebrium/contracts/vocab";
import { NODES_REPO_TOKEN, type NodesRepo } from "@/domain/ports/storage";
import { CallPipeline } from "@/application/call-pipeline";
import { OPEN_PROFILE, PrincipalsConfig, type PrincipalProfile } from "@/infrastructure/config";
import { setup } from "@test/helpers";

const TOPIC = "the http client retries with exponential backoff on a 503";
const SWEEP = "cerebrium-consolidation";

function weighted(weight: number): PrincipalProfile {
  return { capabilities: {}, quota: {}, weight };
}

function policy(profiles: Record<string, PrincipalProfile>): void {
  container.register(PrincipalsConfig, { useValue: { profiles, default: OPEN_PROFILE } });
}

function invoke<T>(name: string, args: Record<string, unknown>, client?: string): Promise<T> {
  return container
    .resolve(CallPipeline)
    .invoke(container, name, args, client ? { client, version: null } : undefined) as Promise<T>;
}

async function sessionAs(client: string): Promise<string> {
  return (await invoke<{ session_id: string }>("start_session", {}, client)).session_id;
}

async function writeAs(client: string, title: string): Promise<string> {
  const written = await invoke<{ envelope: { id: string } }>(
    "write_memory",
    {
      session_id: await sessionAs(client),
      parent_node_id: null,
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title,
      content: TOPIC,
    },
    client,
  );

  return written.envelope.id;
}

async function reviseAs(client: string, id: string, reason: string): Promise<void> {
  await invoke(
    "update_memory",
    { session_id: await sessionAs(client), id, content: `${TOPIC}, revised`, reason },
    client,
  );
}

async function deriveAs(client: string, title: string, sources: string[]): Promise<string> {
  const id = await writeAs(client, title);
  const session_id = await sessionAs(client);

  for (const dst of sources) {
    await invoke("link_nodes", { session_id, src: id, dst, type: "derived_from" }, client);
  }

  return id;
}

async function search(): Promise<{ id: string; authority?: unknown }[]> {
  return (
    await invoke<{ results: { id: string; authority?: unknown }[] }>("search_memory", {
      query: TOPIC,
      limit: 10,
      mode: "text",
    })
  ).results;
}

beforeEach(() => {
  setup();
  policy({});
});

describe("Trust weight follows origin", () => {
  it("should rank a node the sweep rewrote at the sweep's weight", async () => {
    // Given
    const merged = await writeAs("claude-code", "Retry budget");
    const untouched = await writeAs("claude-code", "Retry budget");
    await reviseAs(SWEEP, merged, "merge");

    // When
    policy({ [SWEEP]: weighted(0.5) });
    const results = await search();

    // Then
    const ids = results.map((r) => r.id);

    expect(ids.indexOf(untouched)).toBeLessThan(ids.indexOf(merged));
    expect(results.find((r) => r.id === merged)?.authority).toEqual({
      weight: 0.5,
      weakest: SWEEP,
    });
    expect(results.find((r) => r.id === untouched)).not.toHaveProperty("authority");
  });

  it("should not count a wikilink fix as authorship", async () => {
    // Given
    const fixed = await writeAs("claude-code", "Retry budget");
    await reviseAs(SWEEP, fixed, "wikilink [[retry]] -> [[01ZZZZZZZZZZZZZZZZZZZZZZZZ]] (sweep)");

    // When
    policy({ [SWEEP]: weighted(0.5) });

    // Then
    expect((await search()).find((r) => r.id === fixed)).not.toHaveProperty("authority");
  });

  it("should hide a distill built from a revoked writer's note", async () => {
    // Given
    const source = await writeAs("codex-mcp-client", "Retry budget, source");
    const distill = await deriveAs(SWEEP, "Retry budget, distilled", [source]);

    // When
    policy({ "codex-mcp-client": weighted(0) });

    // Then
    expect((await search()).map((r) => r.id)).not.toContain(distill);
  });

  it("should let the weakest origin set the weight", async () => {
    // Given
    const strong = await writeAs("claude-code", "Retry budget, strong");
    const weak = await writeAs("codex-mcp-client", "Retry budget, weak");
    const distill = await deriveAs(SWEEP, "Retry budget, distilled", [strong, weak]);

    // When
    policy({ [SWEEP]: weighted(0.9), "codex-mcp-client": weighted(0.3) });

    // Then
    expect((await search()).find((r) => r.id === distill)?.authority).toEqual({
      weight: 0.3,
      weakest: "codex-mcp-client",
    });
  });

  it("should report a node's authority on get", async () => {
    // Given
    const merged = await writeAs("claude-code", "Retry budget");
    await reviseAs(SWEEP, merged, "merge");
    policy({ [SWEEP]: weighted(0.9) });

    // When
    const fetched = await invoke<{ nodes: { authority?: unknown }[] }>("fetch_nodes", {
      ids: [merged],
    });

    // Then
    expect(fetched.nodes[0]?.authority).toEqual({ weight: 0.9, weakest: SWEEP });
  });

  it("should not look origins up when nobody is weighted", async () => {
    // Given
    await writeAs("claude-code", "Retry budget");
    const lookup = vi.spyOn(container.resolve<NodesRepo>(NODES_REPO_TOKEN), "originPrincipalsOf");

    // When
    policy({});
    await search();

    // Then
    expect(lookup).not.toHaveBeenCalled();
  });
});
