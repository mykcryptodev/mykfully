"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { addDays, formatInTz, utcToZoned, zonedToUtc } from "../lib/time";
import { IconCalendar } from "../ui/icons";

type Pick = { label: string; date: string; time: string };

function quickPicks(tz: string): Pick[] {
  const now = utcToZoned(Date.now(), tz);
  const tomorrow = addDays(now.date, 1);
  const daysToMonday = ((8 - now.weekday) % 7) || 7;
  const inOneHour = utcToZoned(Date.now() + 60 * 60 * 1000, tz);
  const picks: Pick[] = [
    { label: "In 1 hour", date: inOneHour.date, time: inOneHour.time },
    { label: "Tomorrow, 9:00 AM", date: tomorrow, time: "09:00" },
    { label: "Tomorrow, 12:00 PM", date: tomorrow, time: "12:00" },
    { label: "Tomorrow, 6:00 PM", date: tomorrow, time: "18:00" },
    { label: "Next Monday, 9:00 AM", date: addDays(now.date, daysToMonday), time: "09:00" },
  ];
  if (now.time < "17:00") picks.splice(1, 0, { label: "Today, 6:00 PM", date: now.date, time: "18:00" });
  return picks;
}

export function SchedulePopover({
  tz,
  initial,
  busy,
  onSchedule,
  onClose,
}: {
  tz: string;
  initial: string | null;
  busy: boolean;
  onSchedule: (iso: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const start = useMemo(() => {
    if (initial && new Date(initial).getTime() > Date.now()) return utcToZoned(initial, tz);
    return { date: addDays(utcToZoned(Date.now(), tz).date, 1), time: "09:00" };
  }, [initial, tz]);
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(start.time);
  const picks = useMemo(() => quickPicks(tz), [tz]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const at = date && time ? zonedToUtc(date, time, tz) : null;
  const inPast = !at || at.getTime() <= Date.now();
  const today = utcToZoned(Date.now(), tz).date;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Schedule thread"
      className="animate-pop absolute right-0 top-full z-40 mt-2 w-[320px] max-w-[calc(100vw-24px)] rounded-2xl bg-canvas p-4 text-ink shadow-pop"
    >
      <div className="mb-3 flex items-center gap-2 text-[15px] font-bold">
        <IconCalendar size={17} className="text-accent" /> Schedule
      </div>
      <div className="flex flex-col gap-0.5">
        {picks.map((p) => {
          const pAt = zonedToUtc(p.date, p.time, tz);
          const selected = p.date === date && p.time === time;
          return (
            <button
              key={p.label}
              onClick={() => {
                setDate(p.date);
                setTime(p.time);
              }}
              className={`flex items-center justify-between rounded-lg px-3 py-2 text-left text-[14px] transition-colors ${
                selected ? "bg-accent-soft text-accent" : "hover:bg-hover"
              }`}
            >
              <span className="font-medium">{p.label}</span>
              <span className="text-[12px] text-muted">{formatInTz(pAt, tz, { weekday: "short", month: "short", day: "numeric" })}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
        <label className="flex flex-col rounded-md border border-line-strong px-2 pb-1 pt-1 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
          <span className="text-[12px] text-muted">Date</span>
          <input
            type="date"
            value={date}
            min={today}
            onChange={(e) => setDate(e.target.value)}
            className="bg-transparent text-[15px] text-ink outline-none"
          />
        </label>
        <label className="flex flex-col rounded-md border border-line-strong px-2 pb-1 pt-1 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
          <span className="text-[12px] text-muted">Time</span>
          <input
            type="time"
            value={time}
            step={60}
            onChange={(e) => setTime(e.target.value)}
            className="bg-transparent text-[15px] text-ink outline-none"
          />
        </label>
      </div>
      <p className={`mt-2 text-[12px] ${inPast ? "text-danger" : "text-muted"}`}>
        {inPast
          ? "Pick a time in the future."
          : `Posts ${formatInTz(at!, tz, { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${tz.replace(/_/g, " ")}`}
      </p>
      <button
        disabled={inPast || busy}
        onClick={() => at && onSchedule(at.toISOString())}
        className="mt-3 h-9 w-full rounded-full bg-accent text-[15px] font-bold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
      >
        {busy ? "Scheduling…" : initial ? "Reschedule" : "Schedule"}
      </button>
    </div>
  );
}
