import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { DashboardStatus, SweptNotice } from "@cerebrium/contracts/dashboard";
import { useActivityLog } from "./activity-log";
import {
  ActivityBus,
  errorMessage,
  fetchActivity,
  fetchStatus,
  useStream,
  type StreamState,
} from "./api";
import { Activity } from "./components/Activity";
import { Dot, NowProvider } from "./components/common";
import { Consolidation, type ReceivedNotice } from "./components/Consolidation";
import { Overview } from "./components/Overview";
import { CANDIDATES_KEY, Review } from "./components/Review";
import { useBacklogTrend, type Tone } from "./health";

const GraphView = lazy(() => import("./components/Graph"));

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "activity", label: "Activity" },
  { id: "consolidation", label: "Consolidation" },
  { id: "review", label: "Review" },
  { id: "graph", label: "Graph" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const STATUS_KEY = ["status"] as const;
const HEAD_KEY = ["activity", "head"] as const;

function tabFromHash(): TabId {
  const hash = window.location.hash.slice(1);
  return TABS.find((t) => t.id === hash)?.id ?? "overview";
}

function useTab(): [TabId, (tab: TabId) => void] {
  const [tab, setTab] = useState<TabId>(tabFromHash);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const select = useCallback((next: TabId) => {
    window.location.hash = next;
    setTab(next);
  }, []);
  return [tab, select];
}

const STREAM_LABEL: Record<StreamState, [Tone, string]> = {
  connecting: ["neutral", "connecting"],
  live: ["ok", "live"],
  reconnecting: ["warn", "reconnecting"],
};

export function App() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useTab();
  const [notices, setNotices] = useState<ReceivedNotice[]>([]);
  const noticeSeq = useRef(0);
  const [reviewCount, setReviewCount] = useState(0);
  const [activity] = useState(() => new ActivityBus());
  const [graphOpened, setGraphOpened] = useState(tab === "graph");

  useEffect(() => {
    if (tab === "graph") setGraphOpened(true);
  }, [tab]);

  const status = useQuery({
    queryKey: STATUS_KEY,
    queryFn: ({ signal }) => fetchStatus(signal),
    refetchInterval: 15_000,
  });
  const head = useQuery({
    queryKey: HEAD_KEY,
    queryFn: ({ signal }) => fetchActivity({}, signal),
    refetchInterval: 60_000,
  });

  const log = useActivityLog(head.data?.events);
  const trend = useBacklogTrend(status.data);

  const stream = useStream({
    onStatus: (next: DashboardStatus) => queryClient.setQueryData(STATUS_KEY, next),
    onActivity: (entry) => {
      log.push(entry);
      activity.emit(entry);
    },
    onConsolidation: (notice: SweptNotice) => {
      noticeSeq.current += 1;
      const received = { key: noticeSeq.current, at: new Date().toISOString(), notice };
      setNotices((prev) => [received, ...prev].slice(0, 20));
      void queryClient.invalidateQueries({ queryKey: HEAD_KEY });
      void queryClient.invalidateQueries({ queryKey: CANDIDATES_KEY });
    },
    onOpen: (reconnected) => {
      if (reconnected) void queryClient.invalidateQueries();
    },
  });

  const statusError = status.isError ? errorMessage(status.error) : null;
  const headError = head.isError ? errorMessage(head.error) : null;
  const [streamTone, streamLabel] = STREAM_LABEL[stream];

  return (
    <NowProvider intervalMs={5_000}>
      <div className="app">
        <header className="topbar">
          <div className="brand">
            Cerebrium <span className="muted">dashboard</span>
          </div>
          <nav className="tabs" aria-label="Sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={t.id === tab ? "tab tab-active" : "tab"}
                aria-current={t.id === tab ? "page" : undefined}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {t.id === "activity" && log.paused && log.buffered > 0 && (
                  <span className="tab-count">{log.buffered}</span>
                )}
                {t.id === "review" && reviewCount > 0 && (
                  <span className="tab-count" title={`${reviewCount} waiting for review`}>
                    {reviewCount}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="conn" title={`Event stream: ${streamLabel}`}>
            <Dot tone={streamTone} label={`Event stream ${streamLabel}`} />
            {streamLabel}
          </div>
        </header>
        <main className="content">
          <div hidden={tab !== "overview"}>
            <Overview status={status.data} error={statusError} trend={trend} />
          </div>
          <div hidden={tab !== "activity"}>
            <Activity log={log} loading={head.isPending} error={headError} />
          </div>
          <div hidden={tab !== "consolidation"}>
            <Consolidation
              runs={head.data?.runs}
              notices={notices}
              loading={head.isPending}
              error={headError}
            />
          </div>
          <div hidden={tab !== "review"}>
            <Review onCount={setReviewCount} />
          </div>
          {graphOpened && (
            <div hidden={tab !== "graph"}>
              <Suspense fallback={<p className="loading">Loading the graph…</p>}>
                <GraphView active={tab === "graph"} activity={activity} />
              </Suspense>
            </div>
          )}
        </main>
      </div>
    </NowProvider>
  );
}
