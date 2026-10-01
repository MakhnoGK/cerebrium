import type { DashboardStatus } from "@cerebrium/contracts/dashboard";
import { formatBytes, formatNumber } from "../format";
import { deriveIssues, isFailedJob, jobTone, type BacklogTrend, type Tone } from "../health";
import { Badge, Card, Empty, ErrorText, Kv, Mono, Notice, RelTime } from "./common";

interface Props {
  status: DashboardStatus | undefined;
  error: string | null;
  trend: BacklogTrend | null;
}

export function Overview({ status, error, trend }: Props) {
  if (!status) {
    return error ? (
      <Notice tone="err">
        <strong>Cannot load status.</strong> {error}. Retrying automatically.
      </Notice>
    ) : (
      <p className="loading">Loading status…</p>
    );
  }

  return (
    <div className="stack">
      {error && (
        <Notice tone="warn">
          Backend unreachable ({error}). Showing the last status from{" "}
          <RelTime iso={status.generated_at} />; retrying.
        </Notice>
      )}
      <HealthBanner status={status} trend={trend} />
      <div className="grid">
        <DaemonCard status={status} />
        <StoreCard status={status} />
        <QueueCard status={status} trend={trend} />
        <GenerationCard status={status} />
        <ConsolidationCard status={status} />
        <ReviewCard status={status} />
        <GraphCard status={status} />
        <JobsCard status={status} />
      </div>
    </div>
  );
}

function HealthBanner({ status, trend }: { status: DashboardStatus; trend: BacklogTrend | null }) {
  const issues = deriveIssues(status, trend);
  const tone: Tone = issues.some((i) => i.level === "err")
    ? "err"
    : issues.length > 0
      ? "warn"
      : "ok";
  return (
    <section className={`banner banner-${tone}`} aria-live="polite">
      <div className="banner-title">
        {tone === "ok"
          ? "All systems healthy"
          : `${issues.length} issue${issues.length === 1 ? "" : "s"} need attention`}
        <span className="banner-time">
          updated <RelTime iso={status.generated_at} />
        </span>
      </div>
      {issues.length > 0 && (
        <ul className="banner-list">
          {issues.map((issue) => (
            <li key={issue.text} className={`issue-${issue.level}`}>
              {issue.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function okBadge(ok: boolean, yes = "ok", no = "down") {
  return <Badge tone={ok ? "ok" : "err"}>{ok ? yes : no}</Badge>;
}

function DaemonCard({ status }: { status: DashboardStatus }) {
  const { daemon, processes } = status;
  const procsOk = processes.every((p) => p.alive && !p.model_error);
  const tone: Tone = !status.kernel_connected || !daemon.ok ? "err" : procsOk ? "ok" : "err";
  return (
    <Card title="Daemon" tone={tone} aside={okBadge(daemon.ok && status.kernel_connected)} wide>
      <Kv
        rows={[
          ["Kernel", okBadge(status.kernel_connected, "connected", "disconnected")],
          ["PID", <span className="num">{daemon.pid ?? "—"}</span>],
          ["Protocol", <span className="num">{daemon.protocol ?? "—"}</span>],
          ["Model", <Mono text={daemon.model} max={40} />],
          ["Error", <ErrorText text={daemon.error} />],
        ]}
      />
      {processes.length === 0 ? (
        <Empty>No processes reported.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>PID</th>
                <th>State</th>
                <th>Model</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {processes.map((p) => (
                <tr key={`${p.role}-${p.pid}`}>
                  <td>{p.role}</td>
                  <td className="num">{p.pid}</td>
                  <td>{okBadge(p.alive, "alive", "dead")}</td>
                  <td>
                    {p.model_error ? (
                      <ErrorText text={p.model_error} max={60} />
                    ) : (
                      (p.model_state ?? <span className="muted">—</span>)
                    )}
                  </td>
                  <td>
                    <RelTime iso={p.started_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Unavailable() {
  return <Empty>Statistics unavailable.</Empty>;
}

function StoreCard({ status }: { status: DashboardStatus }) {
  const stats = status.stats;
  if (!stats) {
    return (
      <Card title="Store" tone="neutral">
        <Unavailable />
      </Card>
    );
  }
  const { content, storage } = stats;
  const kinds = Object.entries(content.nodes_by_kind).sort((a, b) => b[1] - a[1]);
  return (
    <Card title="Store" tone="ok">
      <div className="metrics">
        <Metric label="Nodes" value={content.nodes_total} />
        <Metric label="Edges" value={content.edges} />
        <Metric label="DB size" text={formatBytes(storage.db_bytes)} />
      </div>
      {kinds.length > 0 && (
        <ul className="chips">
          {kinds.map(([kind, n]) => (
            <li key={kind}>
              {kind} <span className="num">{formatNumber(n)}</span>
            </li>
          ))}
        </ul>
      )}
      <Kv
        rows={[
          ["Chunks embedded", <span className="num">{formatNumber(content.chunks_embedded)}</span>],
          [
            "Chunks unembedded",
            <span className={`num${content.chunks_unembedded > 0 ? " text-warn" : ""}`}>
              {formatNumber(content.chunks_unembedded)}
            </span>,
          ],
          ["Chunks stale", <span className="num">{formatNumber(content.chunks_stale)}</span>],
          ["WAL", <span className="num">{formatBytes(storage.wal_bytes)}</span>],
          [
            "Sessions / events",
            <span className="num">{`${formatNumber(content.sessions)} / ${formatNumber(content.events)}`}</span>,
          ],
          ["Last activity", <RelTime iso={stats.last_activity} />],
        ]}
      />
    </Card>
  );
}

function Metric({
  label,
  value,
  text,
  tone,
}: {
  label: string;
  value?: number | null;
  text?: string;
  tone?: Tone;
}) {
  return (
    <div className={`metric${tone ? ` metric-${tone}` : ""}`}>
      <span className="metric-value num">{text ?? formatNumber(value)}</span>
      <span className="metric-label">{label}</span>
    </div>
  );
}

function QueueCard({ status, trend }: { status: DashboardStatus; trend: BacklogTrend | null }) {
  const queue = status.stats?.queue;
  if (!queue) {
    return (
      <Card title="Embedding queue" tone="neutral">
        <Unavailable />
      </Card>
    );
  }
  const tone: Tone = queue.parked > 0 || trend?.growing ? "warn" : "ok";
  return (
    <Card
      title="Embedding queue"
      tone={tone}
      aside={trend?.growing ? <Badge tone="warn">growing</Badge> : undefined}
    >
      <div className="metrics">
        <Metric label="Backlog" value={queue.backlog} tone={trend?.growing ? "warn" : undefined} />
        <Metric label="Parked" value={queue.parked} tone={queue.parked > 0 ? "warn" : undefined} />
        <Metric
          label="With errors"
          value={queue.with_errors}
          tone={queue.with_errors > 0 ? "warn" : undefined}
        />
      </div>
      <Kv
        rows={[
          ["Total", <span className="num">{formatNumber(queue.total)}</span>],
          ["Oldest enqueued", <RelTime iso={queue.oldest_enqueued_at} />],
          ["Drain lease", <DrainLease status={status} />],
        ]}
      />
    </Card>
  );
}

function DrainLease({ status }: { status: DashboardStatus }) {
  const drain = status.stats?.drain;
  if (!drain) return <span className="muted">—</span>;
  return drain.lease_active ? (
    <span>
      <Mono text={drain.lease_owner} max={24} /> until <RelTime iso={drain.lease_expires_at} />
    </span>
  ) : (
    <span className="muted">idle</span>
  );
}

function GenerationCard({ status }: { status: DashboardStatus }) {
  const { generation, ollama } = status;
  const enabled = generation?.enabled ?? false;
  const tone: Tone = !enabled ? "neutral" : ollama.ok ? "ok" : "err";
  return (
    <Card
      title="Generation"
      tone={tone}
      aside={<Badge tone={enabled ? "info" : "neutral"}>{enabled ? "enabled" : "disabled"}</Badge>}
    >
      <Kv
        rows={[
          ["Provider", generation?.provider ?? <span className="muted">—</span>],
          ["Model", <Mono text={generation?.model} max={40} />],
          ["Ollama", <Mono text={ollama.url} max={40} />],
          ["Reachable", okBadge(ollama.ok, "yes", "no")],
          ["Error", <ErrorText text={ollama.error} />],
        ]}
      />
      {ollama.models.length > 0 ? (
        <ul className="chips">
          {ollama.models.map((m) => (
            <li key={m} className={m === generation?.model ? "chip-active" : undefined}>
              <code className="mono">{m}</code>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No models listed.</Empty>
      )}
    </Card>
  );
}

function ConsolidationCard({ status }: { status: DashboardStatus }) {
  const c = status.stats?.consolidation;
  if (!c) {
    return (
      <Card title="Consolidation" tone="neutral">
        <Unavailable />
      </Card>
    );
  }
  return (
    <Card
      title="Consolidation"
      tone={c.last_error ? "warn" : "ok"}
      aside={
        c.sweep_running ? (
          <Badge tone="info">sweep running</Badge>
        ) : (
          <Badge tone="neutral">idle</Badge>
        )
      }
    >
      <div className="metrics">
        <Metric label="Pending" value={c.pending} />
        <Metric label="Applied" value={c.applied} />
        <Metric label="Dismissed" value={c.dismissed} />
      </div>
      <Kv
        rows={[
          ["Runs", <span className="num">{formatNumber(c.runs_total)}</span>],
          ["Last run", <RelTime iso={c.last_run_at} />],
          ["Last stage", c.last_stage ?? <span className="muted">—</span>],
          ["Last error", <ErrorText text={c.last_error} />],
        ]}
      />
    </Card>
  );
}

function ReviewCard({ status }: { status: DashboardStatus }) {
  const n = status.review_pending;
  return (
    <Card title="Review backlog" tone={n === null ? "neutral" : n > 0 ? "info" : "ok"}>
      <div className="metrics">
        <Metric label="Pending review" value={n} />
      </div>
    </Card>
  );
}

function GraphCard({ status }: { status: DashboardStatus }) {
  const g = status.stats?.graph;
  if (!g) {
    return (
      <Card title="Graph integrity" tone="neutral">
        <Unavailable />
      </Card>
    );
  }
  const clean = g.dangling_edges === 0 && g.repointable_edges === 0 && g.detached_nodes === 0;
  return (
    <Card title="Graph integrity" tone={g.dangling_edges > 0 ? "warn" : clean ? "ok" : "neutral"}>
      <div className="metrics">
        <Metric
          label="Dangling"
          value={g.dangling_edges}
          tone={g.dangling_edges > 0 ? "warn" : undefined}
        />
        <Metric label="Repointable" value={g.repointable_edges} />
        <Metric label="Detached" value={g.detached_nodes} />
        <Metric label="Edgeless" value={g.edgeless_nodes} />
        <Metric label="Untyped links" value={g.untyped_links} />
        <Metric
          label="Typed"
          text={
            g.typed_links + g.untyped_links === 0
              ? "—"
              : `${String(Math.round((100 * g.typed_links) / (g.typed_links + g.untyped_links)))}%`
          }
        />
      </div>
    </Card>
  );
}

function JobsCard({ status }: { status: DashboardStatus }) {
  const jobs = status.stats?.jobs;
  const failed = status.jobs.filter(isFailedJob).length;
  const byState = Object.entries(jobs?.by_state ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <Card title="Jobs" tone={failed > 0 ? "warn" : "ok"} wide>
      {byState.length > 0 && (
        <ul className="chips">
          {byState.map(([state, n]) => (
            <li key={state}>
              <Badge tone={jobTone(state)}>{state}</Badge>{" "}
              <span className="num">{formatNumber(n)}</span>
            </li>
          ))}
        </ul>
      )}
      {jobs && (
        <Kv
          rows={[
            [
              "Code index",
              jobs.code_index_open ? (
                <Badge tone="info">running</Badge>
              ) : (
                <span>
                  last <RelTime iso={jobs.last_code_index_at} />
                </span>
              ),
            ],
            ["Code index error", <ErrorText text={jobs.last_code_index_error} />],
          ]}
        />
      )}
      {status.jobs.length === 0 ? (
        <Empty>No recent jobs.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>State</th>
                <th className="num">Attempts</th>
                <th>Ended</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {status.jobs.map((job) => (
                <tr key={job.id} className={isFailedJob(job) ? "row-err" : undefined}>
                  <td title={job.id}>{job.kind}</td>
                  <td>
                    <Badge tone={jobTone(job.state)}>{job.state}</Badge>
                  </td>
                  <td className="num">
                    {job.attempts}/{job.max_attempts}
                  </td>
                  <td>
                    {job.ended_at ? (
                      <RelTime iso={job.ended_at} />
                    ) : (
                      <span className="muted">
                        {job.started_at ? "started " : "queued "}
                        <RelTime iso={job.started_at ?? job.created_at} />
                      </span>
                    )}
                  </td>
                  <td>
                    <ErrorText text={job.last_error} max={80} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
