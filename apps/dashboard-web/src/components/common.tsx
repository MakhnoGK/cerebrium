import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { absoluteTime, relativeTime, truncate } from "../format";
import type { Tone } from "../health";

const NowContext = createContext(Date.now());

export function NowProvider({ intervalMs, children }: { intervalMs: number; children: ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return <NowContext.Provider value={now}>{children}</NowContext.Provider>;
}

export function useNow(): number {
  return useContext(NowContext);
}

export function RelTime({ iso }: { iso: string | null | undefined }) {
  const now = useNow();
  if (!iso) return <span className="muted">—</span>;
  return (
    <time dateTime={iso} title={absoluteTime(iso)}>
      {relativeTime(iso, now)}
    </time>
  );
}

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Dot({ tone, label }: { tone: Tone; label?: string }) {
  return <span className={`dot dot-${tone}`} role="img" aria-label={label} title={label} />;
}

export function Card({
  title,
  tone,
  aside,
  wide,
  children,
}: {
  title: string;
  tone?: Tone;
  aside?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`card${wide ? " card-wide" : ""}`}>
      <header className="card-head">
        <h2>
          {tone && <Dot tone={tone} />}
          {title}
        </h2>
        {aside}
      </header>
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Kv({ rows }: { rows: [label: string, value: ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Mono({ text, max = 14 }: { text: string | null | undefined; max?: number }) {
  if (!text) return <span className="muted">—</span>;
  return (
    <code className="mono" title={text}>
      {truncate(text, max)}
    </code>
  );
}

export function ErrorText({ text, max = 120 }: { text: string | null | undefined; max?: number }) {
  if (!text) return <span className="muted">—</span>;
  return (
    <span className="error-text" title={text}>
      {truncate(text, max)}
    </span>
  );
}

export function Notice({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <div className={`notice notice-${tone}`}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
