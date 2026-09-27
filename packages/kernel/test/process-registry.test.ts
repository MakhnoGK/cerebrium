import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { CONFIG_FILE_TOKEN, type ConfigFileReport } from "@/domain/ports/config";
import { PROCESS_PROBE_TOKEN, type ProcessProbe } from "@/domain/ports/process-probe";
import { ProcessRegistryService } from "@/application/services";
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
    model_state: null,
    model_ms: null,
    model_error: null,
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

function probe(self: number, live: number[]): ProcessProbe {
  return { self: () => self, alive: (pid) => live.includes(pid) };
}

function registry(opts: {
  self: number;
  live?: number[];
  file?: ConfigFileReport | null;
}): ProcessRegistryService {
  container.register(PROCESS_PROBE_TOKEN, {
    useValue: probe(opts.self, opts.live ?? []),
  });
  container.register(CONFIG_FILE_TOKEN, { useFactory: () => opts.file ?? null });

  return container.resolve(ProcessRegistryService);
}

describe("Model state on a process row", () => {
  let repo: ProcessesRepo;

  beforeEach(() => {
    setup();
    repo = container.resolve(ProcessesRepo);
  });

  it("should publish a row with no model state, since warming finishes later", () => {
    // Given / When
    repo.publish(row());

    // Then — a reader between publish and warm sees the process up with no model yet.
    const [stored] = repo.list();
    expect(stored).toMatchObject({ model_state: null, model_ms: null, model_error: null });
  });

  it("should record a successful warm-up against the row", () => {
    // Given
    repo.publish(row({ role: "daemon" }));

    // When
    container
      .resolve(ProcessRegistryService)
      .recordModel("01JPROCESS0000000000000001", { state: "ready", ms: 624 });

    // Then
    const [stored] = repo.list();
    expect(stored).toMatchObject({ model_state: "ready", model_ms: 624, model_error: null });
  });

  it("should keep the reason a warm-up failed, so a broken daemon is not silently up", () => {
    // Given
    repo.publish(row({ role: "daemon" }));

    // When
    container.resolve(ProcessRegistryService).recordModel("01JPROCESS0000000000000001", {
      state: "failed",
      ms: 90,
      error: "no such file: model.onnx",
    });

    // Then
    const [stored] = repo.list();
    expect(stored).toMatchObject({
      model_state: "failed",
      model_ms: 90,
      model_error: "no such file: model.onnx",
    });
  });

  it("should leave other processes' rows alone", () => {
    // Given
    repo.publish(row({ id: "01JPROCESS0000000000000001", role: "server", pid: 1 }));
    repo.publish(row({ id: "01JPROCESS0000000000000002", role: "daemon", pid: 2 }));

    // When
    container
      .resolve(ProcessRegistryService)
      .recordModel("01JPROCESS0000000000000002", { state: "ready", ms: 5 });

    // Then
    const byRole = new Map(repo.list().map((r) => [r.role, r.model_state]));
    expect(byRole.get("server")).toBeNull();
    expect(byRole.get("daemon")).toBe("ready");
  });
});

describe("ProcessRegistryService", () => {
  let repo: ProcessesRepo;

  beforeEach(() => {
    setup();
    repo = container.resolve(ProcessesRepo);
  });

  it("should publish this process with the config file it loaded", () => {
    // Given
    const service = registry({
      self: 900,
      file: { path: "/opt/brain/config.json", state: "loaded", keys: 3 },
    });

    // When
    service.publish("server");

    // Then
    expect(repo.list()[0]).toMatchObject({
      role: "server",
      pid: 900,
      config_file: "/opt/brain/config.json",
      config_state: "loaded",
    });
  });

  it("should record a pinned source as such rather than inventing a file", () => {
    // Given / When
    registry({ self: 900, file: null }).publish("cli");

    // Then
    expect(repo.list()[0]).toMatchObject({ config_file: null, config_state: "pinned" });
  });

  it("should publish the resolved config values, not just the paths", () => {
    // Given / When
    registry({ self: 900 }).publish("server");

    // Then
    const published = JSON.parse(repo.list()[0]!.config_json);
    expect(published.database.path).toBe(":memory:");
    expect(published.retrieval).toBeDefined();
  });

  it("should mark a row whose process is gone as not alive", () => {
    // Given
    repo.publish(row({ id: "01JPROCESS0000000000000009", pid: 111 }));

    // When
    const listed = registry({ self: 900, live: [] }).list();

    // Then
    expect(listed[0]).toMatchObject({ pid: 111, alive: false });
  });

  it("should sweep dead rows when a new process publishes, so a crash leaves no ghost", () => {
    // Given
    repo.publish(row({ id: "01JPROCESS0000000000000009", pid: 111, role: "daemon" }));

    // When
    registry({ self: 900, live: [900] }).publish("server");

    // Then
    expect(repo.list().map((p) => p.pid)).toEqual([900]);
  });

  it("should keep a live foreign process while sweeping", () => {
    // Given
    repo.publish(row({ id: "01JPROCESS0000000000000009", pid: 111, role: "daemon" }));

    // When
    registry({ self: 900, live: [111] }).publish("server");

    // Then
    expect(
      repo
        .list()
        .map((p) => p.pid)
        .sort(),
    ).toEqual([111, 900]);
  });

  it("should retire the row it published", () => {
    // Given
    const service = registry({ self: 900, live: [900] });
    const id = service.publish("server");

    // When
    service.retire(id);

    // Then
    expect(repo.list()).toEqual([]);
  });
});
