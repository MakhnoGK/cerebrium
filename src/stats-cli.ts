#!/usr/bin/env node
import "reflect-metadata";
import type Database from "better-sqlite3";
import { StatsRepo } from "@/db/repositories";
import { DB_TOKEN } from "@/db/repositories/base";
import { isDaemonAlive, readDaemonPid } from "@/runtime/daemon-pid";
import { isMainModule } from "@/runtime/is-main";
import { nowIso } from "@/core/ids";
import { buildContainer } from "@/container";
import { DatabaseConfig, RerankConfig } from "@/infrastructure/config";

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

function main(): void {
  const container = buildContainer({ role: "cli" });

  const dbPath = container.resolve(DatabaseConfig).path;
  const asJson = process.argv.includes("--json");
  const db = container.resolve<Database.Database>(DB_TOKEN); // read-only for this role
  try {
    const s = container.resolve(StatsRepo).techStats(nowIso());
    const daemonAlive = isDaemonAlive(dbPath);
    const daemonPid = readDaemonPid(dbPath);

    if (asJson) {
      process.stdout.write(
        JSON.stringify(
          { ...s, drain: { ...s.drain, daemon_alive: daemonAlive, daemon_pid: daemonPid } },
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
    L.push("Reranking");
    L.push(`  provider (env)             : ${container.resolve(RerankConfig).provider}`);
    L.push(
      `  eligible / reranked        : ${s.rerank_usage.eligible_searches} / ${s.rerank_usage.reranked_searches}`,
    );
    L.push(`  candidates reranked        : ${s.rerank_usage.candidates_reranked}`);
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
