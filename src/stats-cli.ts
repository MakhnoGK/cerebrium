#!/usr/bin/env node
import "reflect-metadata";
import type Database from "better-sqlite3";
import type { FieldProvenance } from "@/domain/ports/config";
import {
  OPERATOR_SNAPSHOT,
  type OperatorProcess,
  type OperatorSnapshot,
  type OperatorSnapshotResult,
} from "@/application/use-cases";
import { DB_TOKEN } from "@/db/repositories/base";
import { isMainModule } from "@/runtime/is-main";
import { rpcCall, rpcHandshake, RpcUnavailableError } from "@/runtime/rpc-client";
import { buildContainer } from "@/container";
import { DaemonConfig } from "@/infrastructure/config";

// Read-only inspection command: `cerebrium-stats`. It asks the daemon first and reads the
// database itself only as a fallback, which is the direction the whole surface is moving:
// eventually nothing but the daemon opens the file at all.
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

// A role that holds no model reports "-", not "cold": nothing is missing.
function modelOf(p: OperatorProcess): string {
  if (!p.model_state) return "-";

  const ms = p.model_ms === null ? "" : ` (${String(p.model_ms)}ms)`;

  return p.model_state === "failed"
    ? `failed${ms}: ${p.model_error ?? "unknown"}`
    : `${p.model_state}${ms}`;
}

// The tier each value came from, for the values that are not simply the declared default.
// Printing all of them would bury the three lines that actually explain a deployment.
function overrides(
  provenance: FieldProvenance[],
  values: Record<string, Record<string, unknown>>,
): string[] {
  return provenance
    .filter((entry) => entry.source !== "default")
    .map((entry) => {
      const [section, ...rest] = entry.path.split(".");
      const holder = values[section!];
      const value = holder?.[rest.join(".")];

      return `  ${entry.path.padEnd(38)} ${JSON.stringify(value)}  (${entry.source})`;
    });
}

function render(s: OperatorSnapshotResult, source: string): string {
  const L: string[] = [];
  L.push(`cerebrium  ${s.storage.db_path}`);
  L.push(`report via ${source}`);
  L.push("");
  L.push("Embedding queue");
  L.push(`  backlog (awaiting vectors) : ${s.queue.backlog}`);
  L.push(`  parked (past max retries)  : ${s.queue.parked}`);
  L.push(`  with errors                : ${s.queue.with_errors}`);
  L.push(`  oldest enqueued            : ${s.queue.oldest_enqueued_at ?? "—"}`);
  L.push(`  attempts histogram         : ${JSON.stringify(s.queue.attempts_histogram)}`);
  L.push("");
  L.push("Drain health");
  L.push(
    `  daemon                     : ${
      s.drain.daemon_alive ? `alive (pid ${String(s.drain.daemon_pid)})` : "not running"
    }`,
  );
  L.push(
    `  lease holder               : ${s.drain.lease_owner ?? "—"}${s.drain.lease_active ? " (active)" : ""}`,
  );
  L.push(`  lease expires              : ${s.drain.lease_expires_at ?? "—"}`);
  L.push("");
  L.push("Generation");
  L.push(
    `  provider                   : ${s.generation.provider}${s.generation.enabled ? "" : " (generates nothing)"}`,
  );
  for (const [role, resolved] of Object.entries(s.generation.roles)) {
    const r = resolved as { model: string; url: string; timeout_ms: number; inherited: boolean };

    L.push(
      `  ${role.padEnd(27)}: ${r.model} @ ${String(r.timeout_ms)}ms` +
        (r.inherited ? "" : " (role override)"),
    );
  }
  L.push("");
  L.push("Processes");
  if (s.processes.length === 0) {
    L.push("  none registered");
  }
  for (const p of s.processes) {
    L.push(
      `  ${p.role.padEnd(8)} pid ${String(p.pid).padEnd(8)} ${p.alive ? "alive" : "gone "}  ` +
        `started ${p.started_at}  config ${p.config_state}  model ${modelOf(p)}`,
    );
  }
  L.push("");
  L.push("Configuration");
  const file = s.config.file;
  const deviations = overrides(s.config.provenance, s.config.values);
  L.push(
    `  file                       : ${
      file === null
        ? "pinned by the caller"
        : `${file.path} (${file.state}${file.state === "loaded" ? `, ${String(file.keys)} keys` : ""})`
    }`,
  );
  if (file?.problem !== undefined) {
    L.push(`  file problem               : ${file.problem}`);
  }
  L.push(
    `  non-default values         : ${deviations.length === 0 ? "none" : String(deviations.length)}`,
  );
  L.push(...deviations);
  L.push(
    `  set but unusable           : ${
      s.config.ignored.length === 0 ? "none" : s.config.ignored.join(", ")
    }`,
  );
  L.push("");
  L.push("Content");
  L.push(
    `  nodes                      : ${s.content.nodes_total}  ${JSON.stringify(s.content.nodes_by_kind)}`,
  );
  L.push(`  edges (active)             : ${s.content.edges}`);
  L.push(`  chunks active / stale      : ${s.content.chunks_active} / ${s.content.chunks_stale}`);
  L.push(
    `  chunks embedded / pending  : ${s.content.chunks_embedded} / ${s.content.chunks_unembedded}`,
  );
  L.push(`  sessions / events          : ${s.content.sessions} / ${s.content.events}`);
  L.push("");
  L.push("Graph integrity");
  L.push(`  dangling / repointable     : ${s.graph.dangling_edges} / ${s.graph.repointable_edges}`);
  L.push(`  detached nodes             : ${s.graph.detached_nodes}`);
  L.push("");
  L.push("Consolidation");
  L.push(`  runs total                 : ${s.consolidation.runs_total}`);
  L.push(
    `  sweep now                  : ${
      s.consolidation.sweep_running
        ? `running (${s.consolidation.sweep_lease_owner ?? "?"}, lease to ${s.consolidation.sweep_lease_expires_at ?? "?"})`
        : "idle"
    }`,
  );
  L.push(
    `  candidates                 : ${s.consolidation.pending} pending, ${s.consolidation.applied} applied, ${s.consolidation.dismissed} dismissed`,
  );
  if (s.consolidation.runs_total > 0) {
    L.push(`  last run                   : ${s.consolidation.last_run_at ?? "—"}`);
    L.push(
      `  last error                 : ${s.consolidation.last_error ? `${s.consolidation.last_error} (at ${s.consolidation.last_stage})` : "none"}`,
    );
  }
  L.push("");
  L.push("Jobs");
  L.push(
    `  by state                   : ${
      Object.keys(s.jobs.by_state).length === 0
        ? "none"
        : Object.entries(s.jobs.by_state)
            .map(([state, n]) => `${n} ${state}`)
            .join(", ")
    }`,
  );
  L.push(`  code index open            : ${s.jobs.code_index_open ? "yes" : "no"}`);
  L.push(`  last code index            : ${s.jobs.last_code_index_at ?? "—"}`);
  if (s.jobs.last_code_index_error) {
    L.push(`  last code index error      : ${s.jobs.last_code_index_error}`);
  }
  L.push("");
  L.push("Storage");
  L.push(
    `  db                         : ${fmtBytes(s.storage.db_bytes)}  (${s.storage.page_count} pages × ${s.storage.page_size} B)`,
  );
  L.push(`  wal                        : ${fmtBytes(s.storage.wal_bytes)}`);
  if (s.code_repos.length) {
    L.push("");
    L.push("Indexed repos (provenance)");
    for (const r of s.code_repos) {
      L.push(
        `  ${r.repo.padEnd(20)} ${r.branch ?? "—"}@${r.commit ?? "—"}${r.dirty ? " (dirty)" : ""}  ${r.indexed_at}`,
      );
    }
  }
  L.push("");
  L.push(`last activity: ${s.last_activity ?? "—"}`);

  return L.join("\n") + "\n";
}

// A daemon that is simply not running is the ordinary case and falls through quietly. A
// version mismatch is not: it means a resident daemon is serving an older build, and
// saying so is the only way the reader learns to restart it.
async function fromDaemon(socketPath: string): Promise<OperatorSnapshotResult | null> {
  try {
    await rpcHandshake({ socketPath });

    return (await rpcCall({ socketPath }, "status")) as OperatorSnapshotResult;
  } catch (err) {
    if (!(err instanceof RpcUnavailableError)) {
      process.stderr.write(
        `daemon unusable, reading the database directly: ${(err as Error).message}\n`,
      );
    }

    return null;
  }
}

async function main(): Promise<void> {
  const container = buildContainer({ role: "cli" });
  const asJson = process.argv.includes("--json");
  const forceLocal = process.argv.includes("--local");
  const socketPath = container.resolve(DaemonConfig).socketPath;

  const remote = forceLocal ? null : await fromDaemon(socketPath);

  if (remote !== null) {
    process.stdout.write(
      asJson ? JSON.stringify(remote, null, 2) + "\n" : render(remote, "daemon"),
    );

    return;
  }

  // Resolving the database is what opens it, so the remote path above never touches the
  // file at all.
  const db = container.resolve<Database.Database>(DB_TOKEN);

  try {
    const snapshot = await container.resolve<OperatorSnapshot>(OPERATOR_SNAPSHOT).invoke({});

    process.stdout.write(
      asJson ? JSON.stringify(snapshot, null, 2) + "\n" : render(snapshot, "local database"),
    );
  } finally {
    db.close();
  }
}

if (isMainModule(import.meta.url)) {
  // Tolerate a downstream pipe closing early (e.g. `| head`).
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
  main().catch((err: unknown) => {
    process.stderr.write(`cerebrium-stats failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
