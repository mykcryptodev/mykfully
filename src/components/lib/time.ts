/** Timezone helpers (no deps). All conversions go through Intl. */

function partsIn(ts: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ts))) if (p.type !== "literal") o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day, h: o.hour === 24 ? 0 : o.hour, mi: o.minute, s: o.second };
}

function offsetMs(ts: number, tz: string): number {
  const p = partsIn(ts, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
}

/** Wall-clock date ("YYYY-MM-DD") + time ("HH:mm") in `tz` → UTC Date. DST-safe (two passes). */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const o1 = offsetMs(guess, tz);
  let ts = guess - o1;
  const o2 = offsetMs(ts, tz);
  if (o2 !== o1) ts = guess - o2;
  return new Date(ts);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** UTC instant → wall-clock parts in `tz`. */
export function utcToZoned(at: Date | string | number, tz: string): { date: string; time: string; weekday: number } {
  const ts = new Date(at).getTime();
  const p = partsIn(ts, tz);
  const weekday = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  return { date: `${p.y}-${pad(p.m)}-${pad(p.d)}`, time: `${pad(p.h)}:${pad(p.mi)}`, weekday };
}

/** Add days to a "YYYY-MM-DD" string. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function formatInTz(at: Date | string, tz: string, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: tz, ...opts }).format(new Date(at));
  } catch {
    return new Intl.DateTimeFormat(undefined, opts).format(new Date(at));
  }
}

/** "Thu, Nov 12 · 9:00 AM" */
export function formatSchedule(at: Date | string, tz: string): string {
  const d = formatInTz(at, tz, { weekday: "short", month: "short", day: "numeric" });
  const t = formatInTz(at, tz, { hour: "numeric", minute: "2-digit" });
  return `${d} · ${t}`;
}

/** Compact relative time like X: "now", "5m", "3h", "Nov 4". */
export function relativeShort(at: Date | string, tz: string, now = Date.now()): string {
  const ts = new Date(at).getTime();
  const diff = Math.round((now - ts) / 1000);
  if (diff < 45 && diff > -45) return "now";
  if (diff > 0) {
    if (diff < 3600) return `${Math.round(diff / 60)}m`;
    if (diff < 86400) return `${Math.round(diff / 3600)}h`;
  }
  return formatInTz(at, tz, { month: "short", day: "numeric" });
}

export function listTimezones(): string[] {
  const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  const list = f ? f("timeZone") : [];
  return list.includes("UTC") ? list : ["UTC", ...list];
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
