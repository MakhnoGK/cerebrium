import type { ConsolidationRunSummary, SweptNotice } from "@cerebrium/contracts/dashboard";
import { formatDuration, parseTime } from "../format";
import { Badge, Empty, ErrorText, Notice, RelTime, useNow } from "./common";

export interface ReceivedNotice {
  key: number;
  at: string;
  notice: SweptNotice;
}

interface Props {
  runs: ConsolidationRunSummary[] | undefined;
  notices: ReceivedNotice[];
  loading: boolean;
  error: string | null;
}

export function Consolidation({ runs, notices, loading, error }: Props) {
  return (
    <div className="stack">
      <section className="live-strip" aria-live="polite">
        <h2>Live sweeps</h2>
        {notices.length === 0 ? (
          <Empty>No sweep notices since this page opened.</Empty>
        ) : (
          <ul>
            {notices.slice(0, 8).map((n) => (
              <li key={n.key} className="toast">
                <RelTime iso={n.at} />
                <NoticeSummary notice={n.notice} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && (
        <Notice tone={runs ? "warn" : "err"}>
          Cannot load sweep runs: {error}. Retrying automatically.
        </Notice>
      )}

      {!runs ? (
        loading && <p className="loading">Loading sweep runs…</p>
      ) : runs.length === 0 ? (
        <Empty>No consolidation runs recorded yet.</Empty>
      ) : (
        <RunsTable runs={runs} />
      )}
    </div>
  );
}

function NoticeSummary({ notice }: { notice: SweptNotice }) {
  const parts: [string, number][] = [
    ["links", notice.links_added],
    ["wikilinks", notice.wikilinks_linked],
    ["dangling wikilinks", notice.wikilinks_dangling],
    ["distill", notice.distill_suggested],
    ["merge", notice.merge_suggested],
    ["prune", notice.prune_suggested],
    ["reattached", notice.reattached],
    ["typed links", notice.links_typed],
  ];
  const nonZero = parts.filter(([, n]) => n > 0);
  return (
    <span className="toast-body">
      {nonZero.length === 0
        ? "no changes"
        : nonZero.map(([label, n]) => (
            <span key={label} className="counter">
              <span className="num">+{n}</span> {label}
            </span>
          ))}
      {notice.yielded && <Badge tone="info">yielded</Badge>}
    </span>
  );
}

function RunsTable({ runs }: { runs: ConsolidationRunSummary[] }) {
  const now = useNow();
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Started</th>
            <th className="num">Duration</th>
            <th>Stage</th>
            <th className="num" title="links added / pruned">
              Links
            </th>
            <th className="num" title="distilled / suggested">
              Distill
            </th>
            <th className="num" title="merged / suggested">
              Merge
            </th>
            <th className="num">Pruned</th>
            <th className="num">Annotated</th>
            <th className="num" title="proposals backfilled">
              Backfill
            </th>
            <th className="num" title="documents linked">
              Docs
            </th>
            <th
              className="num"
              title="reattached / links typed / dropped / superseded / sent to review / repointed"
            >
              Integrity
            </th>
            <th className="num" title="wikilinks fixed / unlinked / sent to review">
              Wikilinks
            </th>
            <th className="num" title="generation failures">
              Gen fail
            </th>
            <th>Last error</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const start = parseTime(run.started_at);
            const end = parseTime(run.ended_at);
            const failed = run.generation_failures > 0 || run.last_error !== null;
            return (
              <tr key={run.id} className={failed ? "row-err" : undefined}>
                <td className="nowrap" title={run.id}>
                  <RelTime iso={run.started_at} />
                </td>
                <td className="num nowrap">
                  {start === null ? (
                    "—"
                  ) : end === null ? (
                    <Badge tone="info">running {formatDuration(now - start)}</Badge>
                  ) : (
                    formatDuration(end - start)
                  )}
                </td>
                <td>{run.stage}</td>
                <td className="num">
                  +{run.links_added} / −{run.links_pruned}
                </td>
                <td className="num">
                  {run.distilled} / {run.distill_suggested}
                </td>
                <td className="num">
                  {run.merged} / {run.merge_suggested}
                </td>
                <td className="num">{run.pruned}</td>
                <td className="num">{run.annotated}</td>
                <td className="num">{run.proposals_backfilled}</td>
                <td className="num">{run.documents_linked}</td>
                <td className="num nowrap">
                  {run.integrity
                    ? `${String(run.integrity.reattached)} / ${String(run.integrity.links_typed)} / ` +
                      `${String(run.integrity.links_dropped)} / ${String(run.integrity.superseded ?? 0)} / ` +
                      `${String(run.integrity.links_to_review)} / ` +
                      String(run.integrity.edges_repointed)
                    : "—"}
                </td>
                <td className="num nowrap">
                  {run.integrity?.wikilinks_fixed === undefined
                    ? "—"
                    : `${String(run.integrity.wikilinks_fixed)} / ` +
                      `${String(run.integrity.wikilinks_unlinked ?? 0)} / ` +
                      String(run.integrity.wikilinks_to_review ?? 0)}
                </td>
                <td className="num">
                  {run.generation_failures > 0 ? (
                    <Badge tone="err">{run.generation_failures}</Badge>
                  ) : (
                    <span className="muted">0</span>
                  )}
                </td>
                <td>
                  <ErrorText text={run.last_error} max={80} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
