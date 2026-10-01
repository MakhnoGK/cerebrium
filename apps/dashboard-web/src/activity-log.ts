import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityEntry } from "@cerebrium/contracts/dashboard";
import { ACTIVITY_PAGE_SIZE, errorMessage, fetchActivity } from "./api";

const MAX_ROWS = 1000;

export function entryKey(e: ActivityEntry): string {
  return e.id ?? `${e.ts}|${e.action}|${e.session_id}|${e.node_id ?? ""}`;
}

function merge(current: ActivityEntry[], incoming: ActivityEntry[]): ActivityEntry[] {
  const byKey = new Map<string, ActivityEntry>();
  for (const e of current) byKey.set(entryKey(e), e);
  for (const e of incoming) byKey.set(entryKey(e), e);
  return [...byKey.values()].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

const keepNewest = (rows: ActivityEntry[]) => rows.slice(0, MAX_ROWS);
const keepOldest = (rows: ActivityEntry[]) => rows.slice(Math.max(0, rows.length - MAX_ROWS));

export interface ActivityLog {
  rows: ActivityEntry[];
  paused: boolean;
  buffered: number;
  setPaused: (paused: boolean) => void;
  push: (entry: ActivityEntry) => void;
  loadOlder: () => void;
  loadingOlder: boolean;
  olderError: string | null;
  exhausted: boolean;
  trimmed: boolean;
}

export function useActivityLog(headEvents: ActivityEntry[] | undefined): ActivityLog {
  const [rows, setRows] = useState<ActivityEntry[]>([]);
  const [buffer, setBuffer] = useState<ActivityEntry[]>([]);
  const [paused, setPausedState] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [trimmed, setTrimmed] = useState(false);
  const pausedRef = useRef(false);
  const rowsRef = useRef(rows);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const ingest = useCallback((incoming: ActivityEntry[]) => {
    if (pausedRef.current) setBuffer((b) => keepNewest(merge(b, incoming)));
    else setRows((r) => keepNewest(merge(r, incoming)));
  }, []);

  useEffect(() => {
    if (headEvents) ingest(headEvents);
  }, [headEvents, ingest]);

  const push = useCallback(
    (entry: ActivityEntry) => {
      ingest([entry]);
    },
    [ingest],
  );

  const setPaused = useCallback(
    (next: boolean) => {
      pausedRef.current = next;
      setPausedState(next);
      if (!next) {
        setRows((r) => keepNewest(merge(r, buffer)));
        setBuffer([]);
      }
    },
    [buffer],
  );

  const loadOlder = useCallback(() => {
    const oldest = rowsRef.current[rowsRef.current.length - 1]?.ts;
    setLoadingOlder(true);
    setOlderError(null);
    fetchActivity({ limit: ACTIVITY_PAGE_SIZE, before: oldest })
      .then((page) => {
        if (page.events.length < ACTIVITY_PAGE_SIZE) setExhausted(true);
        if (rowsRef.current.length + page.events.length > MAX_ROWS) setTrimmed(true);
        setRows((r) => keepOldest(merge(r, page.events)));
      })
      .catch((error: unknown) => {
        setOlderError(errorMessage(error));
      })
      .finally(() => {
        setLoadingOlder(false);
      });
  }, []);

  const buffered = useMemo(() => {
    if (buffer.length === 0) return 0;
    const seen = new Set(rows.map(entryKey));
    return buffer.filter((e) => !seen.has(entryKey(e))).length;
  }, [buffer, rows]);

  return {
    rows,
    paused,
    buffered,
    setPaused,
    push,
    loadOlder,
    loadingOlder,
    olderError,
    exhausted,
    trimmed,
  };
}
