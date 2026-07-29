import type BetterSqlite3 from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import type { MirrorRepo, NodesRepo } from "@/db/repositories";
import { mirrorExternalId } from "@/db/repositories/mirror";
import type { MirrorSource } from "@/core/types";
import { setup } from "@test/helpers";
import type { TestClock } from "@test/helpers";

let mirror: MirrorRepo;
let nodes: NodesRepo;
let clock: TestClock;
let db: BetterSqlite3.Database;

beforeEach(() => {
  const t = setup({ start: "2026-03-01T00:00:00.000Z" });
  mirror = t.mirror;
  nodes = t.nodes;
  clock = t.clock;
  db = t.db;
});

function register(overrides?: Partial<MirrorSource>): MirrorSource {
  const o = overrides ?? {};
  return mirror.registerSource({
    id: o.id ?? "grafana-prod",
    kind: o.kind ?? "grafana",
    label: o.label ?? "Grafana (prod)",
    project: o.project ?? "acme",
    freshness_hours: "freshness_hours" in o ? o.freshness_hours : 24,
    ts: clock.t,
  });
}

const INCIDENT = {
  native_id: "INC-42",
  type: "incident",
  title: "Checkout latency spike",
  content: "p99 checkout latency crossed 2s for 12 minutes; rolled back deploy #918.",
  url: "https://grafana/incident/42",
  facets: { severity: "sev2", service: "checkout" },
};

describe("MirrorRepo source registry", () => {
  it("should register, read, and list a source and update it in place when re-registered with the same id", () => {
    // Given / When
    register();

    // Then
    const got = mirror.getSource("grafana-prod")!;
    expect(got.kind).toBe("grafana");
    expect(got.project).toBe("acme");
    expect(got.enabled).toBe(true);
    expect(mirror.listSources()).toHaveLength(1);

    // When / Then
    mirror.registerSource({ id: "grafana-prod", kind: "grafana", label: "Prod", ts: clock.t });
    expect(mirror.getSource("grafana-prod")!.label).toBe("Prod");
    expect(mirror.listSources()).toHaveLength(1);
  });
});

describe("MirrorRepo upsert lifecycle", () => {
  it("should add a mirror node with the right shape, FTS row, and a queued embedding when a new record is upserted", async () => {
    // Given
    const source = register();

    // When
    const r = mirror.upsertMirrors(source, [INCIDENT], "sess", clock.t);

    // Then
    expect(r).toMatchObject({ added: 1, updated: 0, unchanged: 0 });
    const id = r.node_ids[0];

    const full = (await nodes.fullNode(id!))!;
    expect(full.envelope.kind).toBe("mirror");
    expect(full.envelope.type).toBe("incident");
    expect(full.envelope.project).toBe("acme");
    expect(full.content).toContain("p99 checkout latency");

    const node = db
      .prepare("SELECT origin, external_id, synced_at, pending_embedding FROM nodes WHERE id = ?")
      .get(id) as {
      origin: string;
      external_id: string;
      synced_at: string;
      pending_embedding: number;
    };
    expect(node.origin).toBe("grafana");
    expect(node.external_id).toBe(mirrorExternalId("grafana-prod", "INC-42"));
    expect(node.synced_at).toBe(clock.t);
    expect(node.pending_embedding).toBe(1); // embedding queued, FTS-findable immediately

    const fts = db.prepare("SELECT COUNT(*) AS c FROM node_fts WHERE node_id = ?").get(id) as {
      c: number;
    };
    expect(fts.c).toBe(1);
  });

  it("should leave the node unchanged when identical content is re-upserted and add one revision when the content changes", () => {
    // Given
    const source = register();
    mirror.upsertMirrors(source, [INCIDENT], "sess", clock.t);

    // When / Then — same content again -> no new revision, no re-embed.
    const again = mirror.upsertMirrors(source, [INCIDENT], "sess", clock.t);
    expect(again).toMatchObject({ added: 0, updated: 0, unchanged: 1 });
    const id = again.node_ids[0];
    expect(nodes.listRevisions(id!)).toHaveLength(1);

    // When / Then — changed content -> exactly one revision bump.
    const changed = { ...INCIDENT, content: INCIDENT.content + " Root cause: cache stampede." };
    const upd = mirror.upsertMirrors(source, [changed], "sess", clock.t);
    expect(upd).toMatchObject({ added: 0, updated: 1, unchanged: 0 });
    expect(nodes.listRevisions(id!)).toHaveLength(2);
  });

  it("should accept an open-vocabulary record type when it is not a built-in type", async () => {
    // Given
    const slack = register({ id: "slack", kind: "slack", freshness_hours: null });

    // When
    const r = mirror.upsertMirrors(
      slack,
      [{ native_id: "C1/167", type: "canvas", title: "Release plan", content: "The Q3 plan." }],
      "sess",
      clock.t,
    );

    // Then
    expect(r.added).toBe(1);
    expect((await nodes.fullNode(r.node_ids[0]!))!.envelope.type).toBe("canvas");
  });

  it("should store url and facets retrievable via mirrorRecord when a record carries them", () => {
    // Given
    const source = register();

    // When
    const r = mirror.upsertMirrors(source, [INCIDENT], "sess", clock.t);

    // Then
    const rec = mirror.mirrorRecord(r.node_ids[0]!)!;
    expect(rec.url).toBe(INCIDENT.url);
    expect(rec.facets).toEqual(INCIDENT.facets);
    expect(rec.native_id).toBe("INC-42");
    expect(mirrorExternalId("grafana-prod", "INC-42")).toHaveLength(24);
  });

  it("should use the per-item project when it overrides the source default", async () => {
    // Given
    const source = register();

    // When
    const r = mirror.upsertMirrors(
      source,
      [{ ...INCIDENT, project: "checkout-team" }],
      "sess",
      clock.t,
    );

    // Then
    expect((await nodes.fullNode(r.node_ids[0]!))!.envelope.project).toBe("checkout-team");
  });
});

describe("MirrorRepo freshness reporting", () => {
  it("should report stale before first sync, fresh right after, and stale again when the freshness window passes", () => {
    // Given
    const source = register(); // freshness_hours = 24

    // When / Then — never synced yet, but enabled + threshold set -> stale.
    expect(mirror.sourceStatus(clock.t)[0]!).toMatchObject({ stale: true, node_count: 0 });

    // When / Then — just synced -> within window.
    mirror.upsertMirrors(source, [INCIDENT], "sess", clock.t);
    let st = mirror.sourceStatus(clock.t)[0]!;
    expect(st).toMatchObject({ stale: false, node_count: 1 });
    expect(st.hours_stale).toBeCloseTo(0, 5);

    // When / Then — advance 25h -> past the 24h threshold.
    clock.advanceMs(25 * 3_600_000);
    st = mirror.sourceStatus(clock.t)[0]!;
    expect(st.stale).toBe(true);
    expect(st.hours_stale).toBeCloseTo(25, 1);
  });

  it("should never report a source stale when it has no freshness_hours", () => {
    // Given
    register({ id: "slack", kind: "slack", freshness_hours: null });

    // When
    clock.advanceMs(1000 * 3_600_000);

    // Then
    expect(mirror.sourceStatus(clock.t).find((s) => s.id === "slack")!.stale).toBe(false);
  });
});
