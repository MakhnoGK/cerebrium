import "reflect-metadata";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { CONSOLIDATION_PROVIDER_TOKEN } from "@/domain/ports/consolidation-provider";
import { EMBEDDING_PROVIDER_TOKEN } from "@/domain/ports/embedding-provider";
import { openDatabase } from "@/db/database";
import { DB_TOKEN } from "@/db/repositories/base";
import { ClientIdentity, UNKNOWN_WRITER } from "@/runtime/client-identity";
import { pipelinedContainer } from "@/runtime/pipelined-kernel";
import { Server } from "@/presentation/mcp/server";
import { createConsolidator } from "@/consolidation";
import { createProvider } from "@/embeddings";
import { IdentityConfig, StaticConfigSource } from "@/infrastructure/config";

// Brings up a real MCP server whose host environment may pin an identity, connects a client
// that names itself `claude-code` the way both interactive and headless Claude Code do, and
// reports the writer the server settled on.
async function writerAfterHandshake(env: Record<string, string | undefined>) {
  const scope = container.createChildContainer();

  scope.register(DB_TOKEN, { useValue: openDatabase(":memory:") });
  scope.register(CONSOLIDATION_PROVIDER_TOKEN, { useValue: createConsolidator() });
  scope.register(EMBEDDING_PROVIDER_TOKEN, { useValue: createProvider("local-null") });
  scope.register(IdentityConfig, { useValue: new IdentityConfig(new StaticConfigSource(env)) });
  scope.register(ClientIdentity, { useValue: new ClientIdentity() });

  const built = pipelinedContainer(scope);
  const identity = built.resolve(ClientIdentity);

  identity.set(UNKNOWN_WRITER);

  const server = built.resolve(Server);
  const client = new Client({ name: "claude-code", version: "2.1.231" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return identity.get();
}

describe("runner principal", () => {
  it("should take the name from the handshake when the host pins nothing", async () => {
    // Given / When
    const writer = await writerAfterHandshake({});

    // Then
    expect(writer).toEqual({ client: "claude-code", version: "2.1.231" });
  });

  it("should write as the pinned principal when the host names one, even though the handshake says claude-code", async () => {
    // Given / When
    const writer = await writerAfterHandshake({ MEMORY_CLIENT: "cerebrium-runner" });

    // Then
    expect(writer.client).toBe("cerebrium-runner");
  });

  it("should still keep the reported version when the name is pinned", async () => {
    // Given / When
    const writer = await writerAfterHandshake({ MEMORY_CLIENT: "cerebrium-runner" });

    // Then
    expect(writer.version).toBe("2.1.231");
  });

  it("should hold the pinned identity before the handshake completes when the host names one", () => {
    // Given
    const scope = container.createChildContainer();

    scope.register(DB_TOKEN, { useValue: openDatabase(":memory:") });
    scope.register(CONSOLIDATION_PROVIDER_TOKEN, { useValue: createConsolidator() });
    scope.register(EMBEDDING_PROVIDER_TOKEN, { useValue: createProvider("local-null") });
    scope.register(IdentityConfig, {
      useValue: new IdentityConfig(new StaticConfigSource({ MEMORY_CLIENT: "cerebrium-runner" })),
    });
    scope.register(ClientIdentity, { useValue: new ClientIdentity() });

    const built = pipelinedContainer(scope);

    // When — resolved but never connected, so `initialize` has not run.
    built.resolve(Server);

    // Then
    expect(built.resolve(ClientIdentity).get().client).toBe("cerebrium-runner");
  });
});
