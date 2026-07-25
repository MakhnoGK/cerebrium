import { describe, it, expect, beforeEach } from "vitest";
import type BetterSqlite3 from "better-sqlite3";
import { makeCtx } from "./helpers";
import { mirrorExternalId } from "@/db/repositories/mirror";
import type { Repo } from "@/db/repo";
import type { Clock } from "./helpers";
import type { MirrorSource } from "@/core/types";

let repo: Repo;
let clock: Clock;
let db: BetterSqlite3.Database;

beforeEach(() => {
  const t = makeCtx({ start: "2026-03-01T00:00:00.000Z" });
  repo = t.repo;
  clock = t.clock;
  db = t.db;
});

function register(overrides?: Partial<MirrorSource>): MirrorSource {
  const o = overrides ?? {};
  return repo.registerSource({
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

describe("MirrorRepo — source registry", () => {
  it("registers, reads, and lists sources; re-register is idempotent", () => {
    register();
    const got = repo.getSource("grafana-prod")!;
    expect(got.kind).toBe("grafana");
    expect(got.project).toBe("acme");
    expect(got.enabled).toBe(true);
    expect(repo.listSources()).toHaveLength(1);

    // Re-register with a changed label -> update in place, still one row.
    repo.registerSource({ id: "grafana-prod", kind: "grafana", label: "Prod", ts: clock.t });
    expect(repo.getSource("grafana-prod")!.label).toBe("Prod");
    expect(repo.listSources()).toHaveLength(1);
  });
});

describe("MirrorRepo — upsert lifecycle", () => {
  it("adds a mirror node with the right shape, FTS, and a queued embedding", () => {
    const source = register();
    const r = repo.upsertMirrors(source, [INCIDENT], "sess", clock.t);
    expect(r).toMatchObject({ added: 1, updated: 0, unchanged: 0 });
    const id = r.node_ids[0];

    const full = repo.fullNode(id)!;
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

  it("is idempotent: identical content is unchanged; changed content revises once", () => {
    const source = register();
    repo.upsertMirrors(source, [INCIDENT], "sess", clock.t);

    // Same content again -> no new revision, no re-embed.
    const again = repo.upsertMirrors(source, [INCIDENT], "sess", clock.t);
    expect(again).toMatchObject({ added: 0, updated: 0, unchanged: 1 });
    const id = again.node_ids[0];
    expect(repo.listRevisions(id)).toHaveLength(1);

    // Changed content -> exactly one revision bump.
    const changed = { ...INCIDENT, content: INCIDENT.content + " Root cause: cache stampede." };
    const upd = repo.upsertMirrors(source, [changed], "sess", clock.t);
    expect(upd).toMatchObject({ added: 0, updated: 1, unchanged: 0 });
    expect(repo.listRevisions(id)).toHaveLength(2);
  });

  it("accepts open-vocab types with no migration", () => {
    const slack = register({ id: "slack", kind: "slack", freshness_hours: null });
    const r = repo.upsertMirrors(
      slack,
      [{ native_id: "C1/167", type: "canvas", title: "Release plan", content: "The Q3 plan." }],
      "sess",
      clock.t,
    );
    expect(r.added).toBe(1);
    expect(repo.fullNode(r.node_ids[0])!.envelope.type).toBe("canvas");
  });

  it("stores url + facets, retrievable via mirrorRecord, keyed by external_id", () => {
    const source = register();
    const r = repo.upsertMirrors(source, [INCIDENT], "sess", clock.t);
    const id = r.node_ids[0];
    const rec = repo.mirrorRecord(id)!;
    expect(rec.url).toBe(INCIDENT.url);
    expect(rec.facets).toEqual(INCIDENT.facets);
    expect(rec.native_id).toBe("INC-42");
    expect(mirrorExternalId("grafana-prod", "INC-42")).toHaveLength(24);
  });

  it("per-item project overrides the source default", () => {
    const source = register();
    const r = repo.upsertMirrors(
      source,
      [{ ...INCIDENT, project: "checkout-team" }],
      "sess",
      clock.t,
    );
    expect(repo.fullNode(r.node_ids[0])!.envelope.project).toBe("checkout-team");
  });
});

describe("MirrorRepo — freshness", () => {
  it("computes staleness and node_count against a fixed clock", () => {
    const source = register(); // freshness_hours = 24
    // Never synced yet, but enabled + threshold set -> stale.
    expect(repo.sourceStatus(clock.t)[0]).toMatchObject({ stale: true, node_count: 0 });

    repo.upsertMirrors(source, [INCIDENT], "sess", clock.t);
    // Just synced -> within window.
    let st = repo.sourceStatus(clock.t)[0];
    expect(st).toMatchObject({ stale: false, node_count: 1 });
    expect(st.hours_stale).toBeCloseTo(0, 5);

    // Advance 25h -> past the 24h threshold.
    clock.advanceMs(25 * 3_600_000);
    st = repo.sourceStatus(clock.t)[0];
    expect(st.stale).toBe(true);
    expect(st.hours_stale).toBeCloseTo(25, 1);
  });

  it("a source with no freshness_hours is never stale", () => {
    const slack = register({ id: "slack", kind: "slack", freshness_hours: null });
    void slack;
    clock.advanceMs(1000 * 3_600_000);
    expect(repo.sourceStatus(clock.t).find((s) => s.id === "slack")!.stale).toBe(false);
  });
});
