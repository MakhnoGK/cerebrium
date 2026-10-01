import { useEffect, useRef, useState } from "react";
import type {
  ActivityEntry,
  ActivityPage,
  DashboardStatus,
  SweptNotice,
} from "@cerebrium/contracts/dashboard";

export const ACTIVITY_PAGE_SIZE = 100;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new HttpError(res.status, `${path} answered ${res.status} ${res.statusText}`.trim());
  }
  return (await res.json()) as T;
}

export function fetchStatus(signal?: AbortSignal): Promise<DashboardStatus> {
  return getJson<DashboardStatus>("/api/status", signal);
}

export interface ActivityQuery {
  limit?: number;
  before?: string;
}

export function fetchActivity(
  query: ActivityQuery = {},
  signal?: AbortSignal,
): Promise<ActivityPage> {
  const params = new URLSearchParams({ limit: String(query.limit ?? ACTIVITY_PAGE_SIZE) });
  if (query.before) params.set("before", query.before);
  return getJson<ActivityPage>(`/api/activity?${params.toString()}`, signal);
}

export function errorMessage(error: unknown): string {
  if (error instanceof TypeError) return "Network error: the dashboard backend is unreachable";
  if (error instanceof Error) return error.message;
  return String(error);
}

export type StreamState = "connecting" | "live" | "reconnecting";

export interface StreamHandlers {
  onActivity?: (entry: ActivityEntry) => void;
  onConsolidation?: (notice: SweptNotice) => void;
  onStatus?: (status: DashboardStatus) => void;
  onOpen?: (reconnected: boolean) => void;
}

function parse(event: MessageEvent): unknown {
  try {
    return JSON.parse(String(event.data));
  } catch {
    return null;
  }
}

export function useStream(handlers: StreamHandlers): StreamState {
  const handlersRef = useRef(handlers);
  const [state, setState] = useState<StreamState>("connecting");

  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    let source: EventSource | null = null;
    let timer: number | undefined;
    let attempt = 0;
    let opened = false;
    let disposed = false;

    const schedule = () => {
      if (disposed) return;
      const delay = Math.min(30_000, 1_000 * 2 ** attempt);
      attempt += 1;
      timer = window.setTimeout(connect, delay);
    };

    function connect() {
      source = new EventSource("/api/stream");
      source.onopen = () => {
        attempt = 0;
        setState("live");
        handlersRef.current.onOpen?.(opened);
        opened = true;
      };
      source.onerror = () => {
        setState("reconnecting");
        // EventSource gives up for good on a non-2xx or non-SSE response (e.g. a proxy 502).
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          schedule();
        }
      };
      source.addEventListener("activity", (event) => {
        const entry = parse(event) as ActivityEntry | null;
        if (entry) handlersRef.current.onActivity?.(entry);
      });
      source.addEventListener("consolidation", (event) => {
        const notice = parse(event) as SweptNotice | null;
        if (notice) handlersRef.current.onConsolidation?.(notice);
      });
      source.addEventListener("status", (event) => {
        const status = parse(event) as DashboardStatus | null;
        if (status) handlersRef.current.onStatus?.(status);
      });
    }

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      source?.close();
    };
  }, []);

  return state;
}
