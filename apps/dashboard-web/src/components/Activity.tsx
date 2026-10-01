import { useMemo, useState } from "react";
import type { ActivityEntry } from "@cerebrium/contracts/dashboard";
import type { ActivityLog } from "../activity-log";
import { entryKey } from "../activity-log";
import { absoluteTime, clockTime, relativeTime, truncate } from "../format";
import { Badge, Empty, Mono, Notice, useNow } from "./common";

interface Props {
  log: ActivityLog;
  loading: boolean;
  error: string | null;
}

const ALL = "";

function who(e: ActivityEntry): string {
  return e.principal ?? e.client ?? "(unknown)";
}

export function Activity({ log, loading, error }: Props) {
  const [action, setAction] = useState(ALL);
  const [principal, setPrincipal] = useState(ALL);
  const [errorsOnly, setErrorsOnly] = useState(false);

  const actions = useMemo(() => [...new Set(log.rows.map((e) => e.action))].sort(), [log.rows]);
  const principals = useMemo(() => [...new Set(log.rows.map(who))].sort(), [log.rows]);

  const visible = useMemo(
    () =>
      log.rows.filter(
        (e) =>
          (action === ALL || e.action === action) &&
          (principal === ALL || who(e) === principal) &&
          (!errorsOnly || !e.ok),
      ),
    [log.rows, action, principal, errorsOnly],
  );

  return (
    <div className="stack">
      <div className="toolbar">
        <label>
          Action
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value={ALL}>All</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label>
          Principal
          <select value={principal} onChange={(e) => setPrincipal(e.target.value)}>
            <option value={ALL}>All</option>
            {principals.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(e) => setErrorsOnly(e.target.checked)}
          />
          Errors only
        </label>
        <button
          type="button"
          className={log.paused ? "btn btn-active" : "btn"}
          aria-pressed={log.paused}
          onClick={() => log.setPaused(!log.paused)}
        >
          {log.paused
            ? `Resume live${log.buffered > 0 ? ` (${log.buffered} new)` : ""}`
            : "Pause live"}
        </button>
        <span className="toolbar-count muted">
          {visible.length.toLocaleString()} of {log.rows.length.toLocaleString()} rows
        </span>
      </div>

      {error && (
        <Notice tone={log.rows.length > 0 ? "warn" : "err"}>
          Cannot load activity: {error}. Retrying automatically.
        </Notice>
      )}

      {log.rows.length === 0 ? (
        loading ? (
          <p className="loading">Loading activity…</p>
        ) : (
          !error && <Empty>No activity recorded yet.</Empty>
        )
      ) : visible.length === 0 ? (
        <Empty>No rows match the filters.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="log">
            <thead>
              <tr>
                <th>Time</th>
                <th>Principal</th>
                <th>Action</th>
                <th>Result</th>
                <th>Node</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((e) => (
                <Row key={entryKey(e)} entry={e} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {log.rows.length > 0 && (
        <div className="pager">
          {log.trimmed && <span className="muted">Newest rows dropped to stay under 1000.</span>}
          {log.olderError && <span className="error-text">{log.olderError}</span>}
          {log.exhausted ? (
            <span className="muted">Start of history reached.</span>
          ) : (
            <button
              type="button"
              className="btn"
              onClick={log.loadOlder}
              disabled={log.loadingOlder}
            >
              {log.loadingOlder ? "Loading…" : "Load older"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ entry }: { entry: ActivityEntry }) {
  const now = useNow();
  const client = entry.client && entry.client !== entry.principal ? entry.client : null;
  return (
    <tr className={entry.ok ? undefined : "row-err"}>
      <td
        className="num nowrap"
        title={`${absoluteTime(entry.ts)} · ${relativeTime(entry.ts, now)}`}
      >
        {clockTime(entry.ts, now)}
      </td>
      <td title={`session ${entry.session_id}`}>
        {entry.principal ?? <span className="muted">—</span>}
        {client && <div className="sub muted">{client}</div>}
      </td>
      <td>
        <code className="mono">{entry.action}</code>
      </td>
      <td>
        <Badge tone={entry.ok ? "ok" : "err"}>{entry.ok ? "ok" : "error"}</Badge>
      </td>
      <td>
        <Mono text={entry.node_id} />
      </td>
      <td className="detail">
        <Detail value={entry.detail} />
      </td>
    </tr>
  );
}

function Detail({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  if (typeof value !== "object") return <span className="mono">{truncate(String(value), 80)}</span>;
  const compact = JSON.stringify(value);
  if (compact === "{}" || compact === "[]") return <span className="muted">—</span>;
  return (
    <details>
      <summary className="mono">{truncate(compact, 60)}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
