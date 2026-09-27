import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { CONFIG_FILE_TOKEN, type ConfigFileReport } from "@/domain/ports/config";
import { PROCESS_PROBE_TOKEN, type ProcessProbe } from "@/domain/ports/process-probe";
import { PROCESSES_REPO_TOKEN, type ProcessesRepo, type ProcessRow } from "@/domain/ports/storage";
import { ProcessRegistryService } from "@/application/services";
import { setup } from "@test/helpers";

function row(overrides: Partial<ProcessRow> = {}): ProcessRow {
  return {
    id: "01JPROCESS0000000000000001",
    role: "server",
    host: "laptop",
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
    repo = container.resolve<ProcessesRepo>(PROCESSES_REPO_TOKEN);
  });

  it("should publish a process with its resolved configuration", async () => {
    // Given / When
    await repo.publish(row());

    // Then
    expect(await repo.list()).toEqual([row()]);
  });

  it("should keep one row per pid, because a pid is reused after the process dies", async () => {
    // Given
    await repo.publish(row({ id: "01JPROCESS0000000000000001", role: "daemon" }));

    // When
    await repo.publish(row({ id: "01JPROCESS0000000000000002", role: "server" }));

    // Then
    expect(await repo.list()).toHaveLength(1);
    expect((await repo.list())[0]).toMatchObject({
      id: "01JPROCESS0000000000000002",
      role: "server",
    });
  });

  it("should keep the same pid on two hosts apart", async () => {
    // Given
    await repo.publish(row({ id: "01JPROCESS0000000000000001", host: "laptop", pid: 1 }));

    // When
    await repo.publish(row({ id: "01JPROCESS0000000000000002", host: "container", pid: 1 }));

    // Then
    expect((await repo.list()).map((p) => p.host).sort()).toEqual(["container", "laptop"]);
  });

  it("should hold one row per live process side by side", async () => {
    // Given / When
    await repo.publish(row({ id: "01JPROCESS0000000000000001", pid: 1, role: "server" }));
    await repo.publish(row({ id: "01JPROCESS0000000000000002", pid: 2, role: "daemon" }));

    // Then
    expect((await repo.list()).map((p) => p.role)).toEqual(["server", "daemon"]);
  });

  it("should retire the ids it is given and leave the rest", async () => {
    // Given
    await repo.publish(row({ id: "01JPROCESS0000000000000001", pid: 1 }));
    await repo.publish(row({ id: "01JPROCESS0000000000000002", pid: 2 }));

    // When
    await repo.retire(["01JPROCESS0000000000000001"]);

    // Then
    expect((await repo.list()).map((p) => p.id)).toEqual(["01JPROCESS0000000000000002"]);
  });

  it("should tolerate an empty retire list", async () => {
    // Given
    await repo.publish(row());

    // When
    await repo.retire([]);

    // Then
    expect(await repo.list()).toHaveLength(1);
  });
});

function probe(self: number, live: number[]): ProcessProbe {
  return { self: () => self, alive: (pid) => live.includes(pid), host: () => "laptop" };
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
    repo = container.resolve<ProcessesRepo>(PROCESSES_REPO_TOKEN);
  });

  it("should publish a row with no model state, since warming finishes later", async () => {
    // Given / When
    await repo.publish(row());

    // Then — a reader between publish and warm sees the process up with no model yet.
    const [stored] = await repo.list();
    expect(stored).toMatchObject({ model_state: null, model_ms: null, model_error: null });
  });

  it("should record a successful warm-up against the row", async () => {
    // Given
    await repo.publish(row({ role: "daemon" }));

    // When
    await container
      .resolve(ProcessRegistryService)
      .recordModel("01JPROCESS0000000000000001", { state: "ready", ms: 624 });

    // Then
    const [stored] = await repo.list();
    expect(stored).toMatchObject({ model_state: "ready", model_ms: 624, model_error: null });
  });

  it("should keep the reason a warm-up failed, so a broken daemon is not silently up", async () => {
    // Given
    await repo.publish(row({ role: "daemon" }));

    // When
    await container.resolve(ProcessRegistryService).recordModel("01JPROCESS0000000000000001", {
      state: "failed",
      ms: 90,
      error: "no such file: model.onnx",
    });

    // Then
    const [stored] = await repo.list();
    expect(stored).toMatchObject({
      model_state: "failed",
      model_ms: 90,
      model_error: "no such file: model.onnx",
    });
  });

  it("should leave other processes' rows alone", async () => {
    // Given
    await repo.publish(row({ id: "01JPROCESS0000000000000001", role: "server", pid: 1 }));
    await repo.publish(row({ id: "01JPROCESS0000000000000002", role: "daemon", pid: 2 }));

    // When
    await container
      .resolve(ProcessRegistryService)
      .recordModel("01JPROCESS0000000000000002", { state: "ready", ms: 5 });

    // Then
    const byRole = new Map((await repo.list()).map((r) => [r.role, r.model_state]));
    expect(byRole.get("server")).toBeNull();
    expect(byRole.get("daemon")).toBe("ready");
  });
});

describe("ProcessRegistryService", () => {
  let repo: ProcessesRepo;

  beforeEach(() => {
    setup();
    repo = container.resolve<ProcessesRepo>(PROCESSES_REPO_TOKEN);
  });

  it("should publish this process with the config file it loaded", async () => {
    // Given
    const service = registry({
      self: 900,
      file: { path: "/opt/brain/config.json", state: "loaded", keys: 3 },
    });

    // When
    await service.publish("server");

    // Then
    expect((await repo.list())[0]).toMatchObject({
      role: "server",
      pid: 900,
      config_file: "/opt/brain/config.json",
      config_state: "loaded",
    });
  });

  it("should record a pinned source as such rather than inventing a file", async () => {
    // Given / When
    await registry({ self: 900, file: null }).publish("cli");

    // Then
    expect((await repo.list())[0]).toMatchObject({ config_file: null, config_state: "pinned" });
  });

  it("should publish the resolved config values, not just the paths", async () => {
    // Given / When
    await registry({ self: 900 }).publish("server");

    // Then
    const published = JSON.parse((await repo.list())[0]!.config_json);
    expect(published.database.path).toBe(":memory:");
    expect(published.retrieval).toBeDefined();
  });

  it("should mark a row whose process is gone as not alive", async () => {
    // Given
    await repo.publish(row({ id: "01JPROCESS0000000000000009", pid: 111 }));

    // When
    const listed = await registry({ self: 900, live: [] }).list();

    // Then
    expect(listed[0]).toMatchObject({ pid: 111, alive: false });
  });

  it("should sweep dead rows when a new process publishes, so a crash leaves no ghost", async () => {
    // Given
    await repo.publish(row({ id: "01JPROCESS0000000000000009", pid: 111, role: "daemon" }));

    // When
    await registry({ self: 900, live: [900] }).publish("server");

    // Then
    expect((await repo.list()).map((p) => p.pid)).toEqual([900]);
  });

  it("should keep a live foreign process while sweeping", async () => {
    // Given
    await repo.publish(row({ id: "01JPROCESS0000000000000009", pid: 111, role: "daemon" }));

    // When
    await registry({ self: 900, live: [111] }).publish("server");

    // Then
    expect((await repo.list()).map((p) => p.pid).sort()).toEqual([111, 900]);
  });

  it("should leave another host's rows alone, since their pids mean nothing here", async () => {
    // Given
    await repo.publish(
      row({ id: "01JPROCESS0000000000000009", host: "container", pid: 1, role: "daemon" }),
    );

    // When
    await registry({ self: 900, live: [900] }).publish("server");
    const listed = await registry({ self: 900, live: [900] }).list();

    // Then
    expect(listed.find((p) => p.host === "container")).toMatchObject({ pid: 1, alive: true });
  });

  it("should retire the row it published", async () => {
    // Given
    const service = registry({ self: 900, live: [900] });
    const id = await service.publish("server");

    // When
    await service.retire(id);

    // Then
    expect(await repo.list()).toEqual([]);
  });
});
