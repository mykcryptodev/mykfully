"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { addDays, formatInTz, parseSchedulePhrase, resolveScheduleTime, utcToZoned } from "../lib/time";
import { IconCalendar, IconChevronDown, IconX } from "../ui/icons";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
const dayLabel = new Intl.DateTimeFormat(undefined, {
  weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
});
const civilDate = (date: string) => new Date(`${date}T00:00:00Z`);
const monthOf = (date: string) => `${date.slice(0, 7)}-01`;
const EMPTY_PHRASE = { value: "", at: null };

function shiftMonth(date: string, step: number): string {
  const first = civilDate(monthOf(date));
  first.setUTCMonth(first.getUTCMonth() + step);
  return first.toISOString().slice(0, 10);
}

function daysOfMonth(month: string) {
  const first = civilDate(month).getUTCDay();
  const next = shiftMonth(month, 1);
  return Array.from({ length: 42 }, (_, index) => {
    const day = addDays(month, index - first);
    return day >= month && day < next ? day : null;
  });
}

export function SchedulePopover({
  anchorRef,
  tz,
  initial,
  busy,
  onSchedule,
  onClose,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  tz: string;
  initial: string | null;
  busy: boolean;
  onSchedule: (iso: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const phraseRef = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef(false);
  const now = Date.now();
  const [original, setOriginal] = useState(() => initial && Date.parse(initial) > now ? new Date(initial) : null);
  const today = utcToZoned(now, tz).date;
  const [date, setDate] = useState(() => original ? utcToZoned(original, tz).date : addDays(today, 1));
  const [time, setTime] = useState(() => original ? utcToZoned(original, tz).time : "09:00");
  const [calendarDate, setCalendarDate] = useState(date);
  const [phrase, setPhrase] = useState<{ value: string; at: Date | null }>(EMPTY_PHRASE);
  const month = monthOf(calendarDate);
  const days = daysOfMonth(month);
  const hasPhrase = Boolean(phrase.value.trim());
  const at = hasPhrase ? phrase.at : resolveScheduleTime(date, time, tz, original);
  const inPast = !!at && at.getTime() <= now;
  const invalid = !at || inPast;

  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const panel = ref.current;
      if (!anchor || !panel) return;
      const edge = 12;
      const top = anchor.bottom + 8;
      const left = Math.max(edge, Math.min(anchor.right, document.documentElement.clientWidth - edge) - panel.offsetWidth);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.maxHeight = `calc(100dvh - ${top + edge}px)`;
    };
    place();
    phraseRef.current?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    ref.current?.querySelector<HTMLButtonElement>(`[data-date="${calendarDate}"]`)?.focus();
  }, [calendarDate]);

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (!busy && target instanceof Node && !ref.current?.contains(target) && !anchorRef.current?.contains(target)) {
        onClose();
      }
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      anchorRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchorRef, busy, onClose]);

  function chooseDate(day: string) {
    setPhrase(EMPTY_PHRASE);
    setCalendarDate(day);
    setDate(day);
  }

  function choosePhrase(value: string) {
    const enteredAt = Date.now();
    const instant = parseSchedulePhrase(value, tz, enteredAt);
    setPhrase({ value, at: instant });
    if (!instant || instant.getTime() <= enteredAt) return;
    const wallTime = utcToZoned(instant, tz);
    setDate(wallTime.date);
    setCalendarDate(wallTime.date);
    setTime(wallTime.time);
    setOriginal(instant);
  }

  function moveCalendar(day: string, focus: boolean) {
    const next = day < today ? today : day;
    if (next === calendarDate) return;
    pendingFocus.current = focus;
    setCalendarDate(next);
  }

  function handleCalendarKey(event: KeyboardEvent<HTMLButtonElement>, day: string) {
    const weekday = civilDate(day).getUTCDay();
    const step: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
      Home: -weekday,
      End: 6 - weekday,
    };
    if (event.key in step) {
      event.preventDefault();
      moveCalendar(addDays(day, step[event.key]), true);
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      const nextMonth = shiftMonth(month, event.key === "PageUp" ? -1 : 1);
      const lastDay = Number(addDays(shiftMonth(nextMonth, 1), -1).slice(-2));
      moveCalendar(addDays(nextMonth, Math.min(Number(day.slice(-2)), lastDay) - 1), true);
    }
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={id}
      className="animate-pop fixed z-40 w-[340px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-2xl border border-line bg-canvas p-4 text-ink shadow-pop"
    >
      <div className="mb-3 flex items-center gap-2">
        <IconCalendar size={17} className="text-muted" />
        <h2 id={id} className="flex-1 text-[15px] font-bold">{initial ? "Reschedule thread" : "Schedule thread"}</h2>
        <button
          type="button"
          aria-label="Close schedule picker"
          disabled={busy}
          className="rounded-md p-1.5 text-muted hover:bg-hover"
          onClick={() => {
            onClose();
            anchorRef.current?.focus();
          }}
        >
          <IconX size={16} />
        </button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && at && at.getTime() > Date.now()) onSchedule(at.toISOString());
        }}
      >
        <fieldset disabled={busy}>
          <div className="mb-3">
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2">
              <label htmlFor={`${id}-phrase`} className="text-[13px] font-medium">Date and time</label>
              <span className="text-xs text-muted">{tz.replace(/_/g, " ")}</span>
            </div>
            <input
              id={`${id}-phrase`}
              ref={phraseRef}
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={phrase.value}
              aria-describedby={`${id}-examples`}
              aria-invalid={hasPhrase && invalid}
              onChange={(event) => choosePhrase(event.target.value)}
              className="w-full rounded-lg border border-line bg-transparent px-3 py-2 text-base outline-none focus:border-accent focus:ring-1 focus:ring-accent"
              placeholder="e.g. Tomorrow at 9am"
            />
            <p id={`${id}-examples`} className="mt-1.5 text-xs text-muted">
              Try “tomorrow at 9am”, “in 3 hours”, or YYYY-MM-DD at HH:mm.
            </p>
          </div>
          <div className="mb-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => choosePhrase("In 1 hour")}
              className="rounded-lg bg-hover px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-accent-soft"
            >
              In 1 hour
            </button>
            <button
              type="button"
              onClick={() => choosePhrase("Tomorrow at 9:00 AM")}
              className="rounded-lg bg-hover px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-accent-soft"
            >
              Tomorrow at 9:00 AM
            </button>
          </div>
          <div className="rounded-xl border border-line p-2">
            <div className="flex items-center justify-between px-1 py-0.5">
              <button
                type="button"
                aria-label="Previous month"
                disabled={month <= monthOf(today)}
                className="rounded-md p-1.5 text-muted hover:bg-hover disabled:opacity-35"
                onClick={() => moveCalendar(shiftMonth(month, -1), false)}
              >
                <IconChevronDown size={16} className="rotate-90" />
              </button>
              <span id={`${id}-month`} aria-live="polite" className="text-[14px] font-semibold">
                {monthLabel.format(civilDate(month))}
              </span>
              <button
                type="button"
                aria-label="Next month"
                className="rounded-md p-1.5 text-muted hover:bg-hover"
                onClick={() => moveCalendar(shiftMonth(month, 1), false)}
              >
                <IconChevronDown size={16} className="-rotate-90" />
              </button>
            </div>
            <div role="grid" aria-labelledby={`${id}-month`} className="mt-1">
              <div role="row" className="grid grid-cols-7 text-center text-[11px] text-muted">
                {WEEKDAYS.map((day) => <span key={day} role="columnheader" className="py-1">{day}</span>)}
              </div>
              {Array.from({ length: 6 }, (_, week) => (
                <div key={week} role="row" className="grid grid-cols-7">
                  {days.slice(week * 7, week * 7 + 7).map((day, column) => (
                    <div key={column} role="gridcell" aria-selected={day ? day === date : undefined} className="h-8">
                      {day && (
                        <button
                          type="button"
                          data-date={day}
                          tabIndex={day === calendarDate ? 0 : -1}
                          disabled={day < today}
                          aria-current={day === today ? "date" : undefined}
                          aria-label={dayLabel.format(civilDate(day))}
                          onClick={() => chooseDate(day)}
                          onKeyDown={(event) => handleCalendarKey(event, day)}
                          className={`h-full w-full rounded-md text-[13px] tabular-nums outline-offset-[-2px] disabled:opacity-30 ${
                            day === date ? "bg-accent-soft font-bold text-accent" : "text-ink enabled:hover:bg-hover"
                          } ${day === today ? "underline underline-offset-2" : ""}`}
                        >
                          {Number(day.slice(-2))}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
          <label className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 focus-within:border-accent">
            <span className="text-[13px] font-medium">Time</span>
            <input
              type="time"
              value={time}
              step={60}
              onChange={(event) => {
                setTime(event.target.value);
                setPhrase(EMPTY_PHRASE);
              }}
              className="bg-transparent text-[14px] text-ink outline-none"
            />
          </label>
          <p aria-live="polite" className={`mt-2 text-[12px] ${invalid ? "text-danger" : "text-muted"}`}>
            {at && !inPast
              ? formatInTz(at, tz, {
                weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
              })
              : hasPhrase && !at ? "Enter a valid date and time."
                : time && !at ? "This local time doesn’t exist. Choose another time." : "Choose a time in the future."}
          </p>
          <button
            type="submit"
            disabled={invalid || busy}
            className="mt-3 h-9 w-full rounded-lg bg-schedule text-[14px] font-bold text-on-schedule transition-colors enabled:hover:bg-schedule-hover disabled:opacity-50"
          >
            {busy ? "Scheduling…" : "Confirm"}
          </button>
        </fieldset>
      </form>
    </div>
  );
}
