export function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export function relativeTime(iso: string | null | undefined, now: number): string {
  const ms = parseTime(iso);
  if (ms === null) return "—";
  const diff = Math.round((now - ms) / 1000);
  const abs = Math.abs(diff);
  let text: string;
  if (abs < 5) return "just now";
  if (abs < 60) text = `${abs} s`;
  else if (abs < 3600) text = `${Math.floor(abs / 60)} min`;
  else if (abs < 86_400) text = `${Math.floor(abs / 3600)} h`;
  else text = `${Math.floor(abs / 86_400)} d`;
  return diff >= 0 ? `${text} ago` : `in ${text}`;
}

export function absoluteTime(iso: string | null | undefined): string {
  const ms = parseTime(iso);
  return ms === null ? "" : new Date(ms).toLocaleString();
}

export function clockTime(iso: string, now: number): string {
  const ms = parseTime(iso);
  if (ms === null) return iso;
  const date = new Date(ms);
  const time = date.toLocaleTimeString([], { hour12: false });
  return date.toDateString() === new Date(now).toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ${String(Math.floor(s % 60)).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} m`;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit] ?? "B"}`;
}

export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toLocaleString();
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
