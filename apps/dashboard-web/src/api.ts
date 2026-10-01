import { useEffect, useRef, useState } from "react";
import type {
  ActivityEntry,
  ActivityPage,
  CandidateDecisionBody,
  CandidateDecisionResult,
  CandidatePage,
  DashboardStatus,
  ReviewDecisionBody,
  ReviewDecisionResult,
  ReviewPage,
  SweptNotice,
} from "@cerebrium/contracts/dashboard";
import type { GraphQuery, GraphSnapshot } from "@cerebrium/contracts/graph";

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

async function failure(res: Response, path: string): Promise<HttpError> {
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message) {
      return new HttpError(res.status, body.message);
    }
  } catch {
    // not JSON
  }
  return new HttpError(res.status, `${path} answered ${res.status} ${res.statusText}`.trim());
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) throw await failure(res, path);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res, path);
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

export type CandidateKind = "distill" | "merge" | "link" | "prune" | "documents" | "supersede";

export interface CandidateQuery {
  kind?: CandidateKind | null;
  cursor?: string | null;
}

export function fetchCandidates(
  query: CandidateQuery = {},
  signal?: AbortSignal,
): Promise<CandidatePage> {
  const params = new URLSearchParams();
  if (query.kind) params.set("kind", query.kind);
  if (query.cursor) params.set("cursor", query.cursor);
  const qs = params.toString();
  return getJson<CandidatePage>(`/api/consolidation/candidates${qs ? `?${qs}` : ""}`, signal);
}

export function decideCandidate(
  id: string,
  body: CandidateDecisionBody,
): Promise<CandidateDecisionResult> {
  return postJson<CandidateDecisionResult>(
    `/api/consolidation/candidates/${encodeURIComponent(id)}/decision`,
    body,
  );
}

export function retryCandidate(id: string): Promise<{ status: string }> {
  return postJson<{ status: string }>(
    `/api/consolidation/candidates/${encodeURIComponent(id)}/retry`,
  );
}

export function fetchReviews(signal?: AbortSignal): Promise<ReviewPage> {
  return getJson<ReviewPage>("/api/reviews", signal);
}

export function decideReview(body: ReviewDecisionBody): Promise<ReviewDecisionResult> {
  return postJson<ReviewDecisionResult>("/api/reviews/decision", body);
}

export function fetchGraph(query: GraphQuery, signal?: AbortSignal): Promise<GraphSnapshot> {
  const params = new URLSearchParams();
  if (query.invalidated) params.set("invalidated", "1");
  if (query.symbols) params.set("symbols", "1");
  const qs = params.toString();
  return getJson<GraphSnapshot>(`/api/graph${qs ? `?${qs}` : ""}`, signal);
}

export type ActivityListener = (entry: ActivityEntry) => void;

// Fans the stream's activity out to whichever views want it live.
export class ActivityBus {
  private readonly listeners = new Set<ActivityListener>();

  on(listener: ActivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(entry: ActivityEntry): void {
    for (const listener of this.listeners) listener(entry);
  }
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
