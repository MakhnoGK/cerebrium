import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { ProcessesRepo, type ProcessRow } from "@/db/repositories";
import { setup } from "@test/helpers";

function row(overrides: Partial<ProcessRow> = {}): ProcessRow {
  return {
    id: "01JPROCESS0000000000000001",
    role: "server",
    pid: 4242,
    started_at: "2026-08-20T10:00:00.000Z",
    node_version: "v25.0.0",
    db_path: "/home/x/.cerebrium/memory.db",
    config_file: "/home/x/.cerebrium/config.json",
    config_state: "loaded",
    config_json: JSON.stringify({ database: { path: "/home/x/.cerebrium/memory.db" } }),
    ...overrides,
  };
}

describe("ProcessesRepo", () => {
  let repo: ProcessesRepo;

  beforeEach(() => {
    setup();
    repo = container.resolve(ProcessesRepo);
  });

  it("should publish a process with its resolved configuration", () => {
    // Given / When
    repo.publish(row());

    // Then
    expect(repo.list()).toEqual([row()]);
  });

  it("should keep one row per pid, because a pid is reused after the process dies", () => {
    // Given
    repo.publish(row({ id: "01JPROCESS0000000000000001", role: "daemon" }));

    // When
    repo.publish(row({ id: "01JPROCESS0000000000000002", role: "server" }));

    // Then
    expect(repo.list()).toHaveLength(1);
    expect(repo.list()[0]).toMatchObject({ id: "01JPROCESS0000000000000002", role: "server" });
  });

  it("should hold one row per live process side by side", () => {
    // Given / When
    repo.publish(row({ id: "01JPROCESS0000000000000001", pid: 1, role: "server" }));
    repo.publish(row({ id: "01JPROCESS0000000000000002", pid: 2, role: "daemon" }));

    // Then
    expect(repo.list().map((p) => p.role)).toEqual(["server", "daemon"]);
  });

  it("should retire the ids it is given and leave the rest", () => {
    // Given
    repo.publish(row({ id: "01JPROCESS0000000000000001", pid: 1 }));
    repo.publish(row({ id: "01JPROCESS0000000000000002", pid: 2 }));

    // When
    repo.retire(["01JPROCESS0000000000000001"]);

    // Then
    expect(repo.list().map((p) => p.id)).toEqual(["01JPROCESS0000000000000002"]);
  });

  it("should tolerate an empty retire list", () => {
    // Given
    repo.publish(row());

    // When
    repo.retire([]);

    // Then
    expect(repo.list()).toHaveLength(1);
  });
});
