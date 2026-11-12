import { describe, expect, it } from "vitest";
import { parseSchedulePhrase, resolveScheduleTime, utcToZoned } from "@/components/lib/time";

const timezone = "America/New_York";
const now = Date.parse("2026-11-12T02:10:45Z");

describe("schedule phrases", () => {
  it.each([
    ["tomorrow at 9am", "2026-11-12T14:00:00.000Z"],
    [" TODAY  at  10:45 PM ", "2026-11-12T03:45:00.000Z"],
    ["tomorrow at 12am", "2026-11-12T05:00:00.000Z"],
    ["tomorrow at 12pm", "2026-11-12T17:00:00.000Z"],
    ["2026-11-13 at 16:15", "2026-11-13T21:15:00.000Z"],
    ["in 3 hours", "2026-11-12T05:11:00.000Z"],
    ["in 1 minute", "2026-11-12T02:12:00.000Z"],
  ])("resolves %s", (phrase, expected) => {
    expect(parseSchedulePhrase(phrase, timezone, now)?.toISOString()).toBe(expected);
  });

  it.each([
    "tomorrow", "today at 13pm", "tomorrow at 24:00", "tomorrow at 10:60am",
    "in 0 hours", "2026-02-29 at 9am", "2026-03-08 at 2:30am",
  ])("rejects %s", (phrase) => {
    expect(parseSchedulePhrase(phrase, timezone, now)).toBeNull();
  });

  it("keeps the exact instant when a relative pick lands in the repeated hour", () => {
    const instant = parseSchedulePhrase("in 1 hour", timezone, Date.parse("2026-11-01T05:30:00Z"));
    expect(instant?.toISOString()).toBe("2026-11-01T06:30:00.000Z");
    const { date, time } = utcToZoned(instant!, timezone);
    expect(resolveScheduleTime(date, time, timezone, instant)).toBe(instant);
  });
});
