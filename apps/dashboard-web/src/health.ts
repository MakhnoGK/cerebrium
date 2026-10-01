import { useEffect, useRef, useState } from "react";
import type { DashboardJob, DashboardStatus } from "@cerebrium/contracts/dashboard";

export type Tone = "ok" | "warn" | "err" | "info" | "neutral";

export interface Issue {
  level: "warn" | "err";
  text: string;
}

export interface BacklogTrend {
  growing: boolean;
  from: number;
  to: number;
}

const TREND_SAMPLES = 6;

export function useBacklogTrend(status: DashboardStatus | undefined): BacklogTrend | null {
  const samples = useRef<{ at: string; backlog: number }[]>([]);
  const [trend, setTrend] = useState<BacklogTrend | null>(null);
  const at = status?.generated_at;
  const backlog = status?.stats?.queue.backlog;

  useEffect(() => {
    if (at === undefined || backlog === undefined) return;
    const list = samples.current;
    if (list[list.length - 1]?.at === at) return;
    list.push({ at, backlog });
    if (list.length > TREND_SAMPLES) list.shift();
    const first = list[0];
    const last = list[list.length - 1];
    if (!first || !last || list.length < TREND_SAMPLES) {
      setTrend(null);
      return;
    }
    const rising = list.every((s, i) => i === 0 || s.backlog >= (list[i - 1]?.backlog ?? 0));
    setTrend({
      growing: rising && last.backlog > first.backlog,
      from: first.backlog,
      to: last.backlog,
    });
  }, [at, backlog]);

  return trend;
}

export function isFailedJob(job: DashboardJob): boolean {
  return /fail|dead|error/i.test(job.state);
}

export function jobTone(state: string): Tone {
  if (/fail|dead|error/i.test(state)) return "err";
  if (/done|succe|complete/i.test(state)) return "ok";
  if (/run|claim|active|progress/i.test(state)) return "info";
  return "neutral";
}

export function deriveIssues(status: DashboardStatus, trend: BacklogTrend | null): Issue[] {
  const issues: Issue[] = [];
  const err = (text: string) => issues.push({ level: "err", text });
  const warn = (text: string) => issues.push({ level: "warn", text });

  if (!status.kernel_connected)
    err("Backend cannot reach the kernel daemon; values below may be stale");
  if (!status.daemon.ok)
    err(`Daemon probe failed${status.daemon.error ? `: ${status.daemon.error}` : ""}`);
  if (status.generation?.enabled && !status.ollama.ok) {
    err(
      `Ollama unreachable at ${status.ollama.url}${status.ollama.error ? `: ${status.ollama.error}` : ""}`,
    );
  }

  for (const p of status.processes) {
    if (!p.alive) err(`Process ${p.role} (pid ${p.pid}) is not alive`);
    if (p.model_error) err(`Process ${p.role} model error: ${p.model_error}`);
  }

  const failed = status.jobs.filter(isFailedJob);
  if (failed.length > 0) {
    const kinds = [...new Set(failed.map((j) => j.kind))].join(", ");
    warn(`${failed.length} recent job${failed.length === 1 ? "" : "s"} failed (${kinds})`);
  }

  const stats = status.stats;
  if (!stats) {
    warn("Store statistics are unavailable");
    return issues;
  }
  if (stats.queue.parked > 0) warn(`${stats.queue.parked} embedding job(s) parked`);
  if (trend?.growing) warn(`Embedding backlog growing (${trend.from} → ${trend.to})`);
  if (stats.consolidation.last_error)
    warn(`Consolidation error: ${stats.consolidation.last_error}`);
  if (stats.jobs.last_code_index_error)
    warn(`Code index error: ${stats.jobs.last_code_index_error}`);
  if (stats.graph.dangling_edges > 0)
    warn(`${stats.graph.dangling_edges} dangling edge(s) in the graph`);
  return issues;
}
