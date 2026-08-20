#!/usr/bin/env node
import "reflect-metadata";
import type Database from "better-sqlite3";
import {
  CONFIG_FILE_TOKEN,
  type ConfigFileReport,
  type FieldProvenance,
} from "@/domain/ports/config";
import { ProcessRegistryService } from "@/application/services";
import { StatsRepo } from "@/db/repositories";
import { DB_TOKEN } from "@/db/repositories/base";
import { isDaemonAlive, readDaemonPid } from "@/runtime/daemon-pid";
import { isMainModule } from "@/runtime/is-main";
import { nowIso } from "@/core/ids";
import { buildContainer } from "@/container";
import { ConfigRegistry, DatabaseConfig } from "@/infrastructure/config";

// Read-only inspection command: `cerebrium-stats`. Safe to run anytime,
// including while no MCP server or daemon is up — it never writes.
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

// The tier each value came from, for the values that are not simply the declared default.
// Printing all of them would bury the three lines that actually explain a deployment.
function overrides(provenance: FieldProvenance[], values: Record<string, unknown>): string[] {
  return provenance
    .filter((entry) => entry.source !== "default")
    .map((entry) => {
      const [section, ...rest] = entry.path.split(".");
      const holder = values[section!] as Record<string, unknown> | undefined;
      const value = holder?.[rest.join(".")];

      return `  ${entry.path.padEnd(38)} ${JSON.stringify(value)}  (${entry.source})`;
    });
}

function main(): void {
  const container = buildContainer({ role: "cli" });

  const dbPath = container.resolve(DatabaseConfig).path;
  const asJson = process.argv.includes("--json");
  const db = container.resolve<Database.Database>(DB_TOKEN); // read-only for this role
  try {
    const s = container.resolve(StatsRepo).techStats(nowIso());
    const daemonAlive = isDaemonAlive(dbPath);
    const daemonPid = readDaemonPid(dbPath);
    const processes = container.resolve(ProcessRegistryService).list();
    const config = container.resolve(ConfigRegistry);
    const effective = config.effective();
    const file = container.resolve<ConfigFileReport | null>(CONFIG_FILE_TOKEN);

    if (asJson) {
      process.stdout.write(
        JSON.stringify(
          {
            ...s,
            drain: { ...s.drain, daemon_alive: daemonAlive, daemon_pid: daemonPid },
            processes,
            config: {
              file,
              values: effective.values,
              provenance: effective.provenance,
              ignored: config.ignored(),
            },
          },
          null,
          2,
        ) + "\n",
      );
      return;
    }

    const L: string[] = [];
    L.push(`cerebrium  ${s.storage.db_path}`);
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
      `  daemon                     : ${daemonAlive ? `alive (pid ${daemonPid})` : "not running"}`,
    );
    L.push(
      `  lease holder               : ${s.drain.lease_owner ?? "—"}${s.drain.lease_active ? " (active)" : ""}`,
    );
    L.push(`  lease expires              : ${s.drain.lease_expires_at ?? "—"}`);
    L.push("");
    L.push("Processes");
    if (processes.length === 0) {
      L.push("  none registered");
    }
    for (const p of processes) {
      L.push(
        `  ${p.role.padEnd(8)} pid ${String(p.pid).padEnd(8)} ${p.alive ? "alive" : "gone "}  ` +
          `started ${p.started_at}  config ${p.config_state}`,
      );
    }
    L.push("");
    L.push("Configuration");
    const ignored = config.ignored();
    const deviations = overrides(effective.provenance, effective.values);
    L.push(
      `  file                       : ${
        file === null
          ? "pinned by the caller"
          : `${file.path} (${file.state}${file.state === "loaded" ? `, ${file.keys} keys` : ""})`
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
        ignored.length === 0 ? "none" : ignored.map((entry) => entry.envName).join(", ")
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
    L.push(
      `  dangling / repointable     : ${s.graph.dangling_edges} / ${s.graph.repointable_edges}`,
    );
    L.push(`  detached nodes             : ${s.graph.detached_nodes}`);
    L.push("");

    L.push("Consolidation");
    L.push(`  runs total                 : ${s.consolidation.runs_total}`);
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
    process.stdout.write(L.join("\n") + "\n");
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
  try {
    main();
  } catch (err) {
    process.stderr.write(`cerebrium-stats failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
