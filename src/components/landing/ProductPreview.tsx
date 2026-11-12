import { VerifiedBadge } from "../ui/VerifiedBadge";
import { IconCalendar, IconClock, IconDoc, IconEye, IconSend, XBookmark, XLike, XReply, XRepost, XShare, XViews } from "../ui/icons";

// Static, non-interactive mock of the app for the signed-out landing page. Plain server markup:
// no client JS, no API calls, nothing that spends credits.

type Segment = { text: string; entity?: boolean };
const THREAD: { segments: Segment[]; count: number }[] = [
  {
    segments: [
      { text: "Shipping in public, week 12 🧵\n\nWe moved scheduling to a cron that runs every minute. Here's what broke, and what we learned from " },
      { text: "@vercel", entity: true },
      { text: " ↓" },
    ],
    count: 154,
  },
  {
    segments: [
      { text: "1. Never trust a retry. Save each post's id the moment it goes out, so a failed thread resumes instead of double-posting." },
    ],
    count: 129,
  },
  {
    segments: [
      { text: "2. Write the whole thread first, then pick a time. Drafts autosave as you type. " },
      { text: "#buildinpublic", entity: true },
    ],
    count: 93,
  },
];

const SIDEBAR = [
  { label: "Drafts", count: 4, active: true },
  { label: "Scheduled", count: 2 },
  { label: "Published", count: 18 },
];

const QUEUE = [
  { day: "Today", time: "4:30 PM", text: "Shipping in public, week 12 🧵" },
  { day: "Tomorrow", time: "9:00 AM", text: "The 3 tools I use to write every day" },
];

const ACTIONS = [XReply, XRepost, XLike, XViews, XBookmark, XShare];

function MockAvatar({ size = 40 }: { size?: number }) {
  return (
    <div
      aria-hidden
      style={{ width: size, height: size, fontSize: size * 0.38 }}
      className="flex shrink-0 items-center justify-center rounded-full bg-accent-soft font-semibold text-accent"
    >
      Y
    </div>
  );
}

export function ProductPreview() {
  return (
    <div
      role="img"
      aria-label="Preview of the mykfully editor: a three-post thread being written, with a schedule queue"
      className="overflow-hidden rounded-2xl border border-line-strong bg-canvas text-left shadow-pop"
    >
      {/* Window chrome */}
      <div aria-hidden className="flex h-9 items-center gap-1.5 border-b border-line bg-sidebar px-4">
        <span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
        <span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
        <span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
        <span className="ml-3 truncate text-[11px] text-faint">mykfully.com</span>
      </div>

      <div aria-hidden className="flex min-h-[420px]">
        {/* Sidebar */}
        <aside className="hidden w-48 shrink-0 flex-col gap-1 border-r border-line bg-sidebar p-3 md:flex">
          <div className="mb-2 flex items-center gap-2 px-2 py-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="" width={22} height={22} className="h-[22px] w-[22px] rounded-md" />
            <span className="text-sm font-bold text-ink">mykfully</span>
          </div>
          <div className="mb-2 flex h-8 items-center justify-center rounded-full bg-ink text-[13px] font-bold text-canvas">
            New draft
          </div>
          {SIDEBAR.map((item) => (
            <div
              key={item.label}
              className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 text-[13px] ${
                item.active ? "bg-hover font-semibold text-ink" : "text-muted"
              }`}
            >
              {item.label}
              <span className="text-[11px] tabular-nums text-faint">{item.count}</span>
            </div>
          ))}
        </aside>

        {/* Composer */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
            <IconDoc size={15} className="text-muted" />
            <span className="truncate text-[12px] text-muted">Saved</span>
            <span className="flex-1" />
            <span className="hidden h-7 items-center gap-1 rounded-lg px-2 text-[12px] font-semibold text-muted sm:flex">
              <IconEye size={15} /> Preview
            </span>
            <span className="flex h-7 items-center gap-1 rounded-lg bg-schedule px-2.5 text-[12px] font-semibold text-on-schedule">
              <IconCalendar size={13} /> Schedule
            </span>
            <span className="flex h-7 items-center rounded-lg bg-accent px-2.5 text-[12px] font-semibold text-white">Publish</span>
          </div>

          <div className="mx-auto w-full max-w-[560px] px-2 pt-3 sm:px-4">
            {THREAD.map((post, i) => {
              const last = i === THREAD.length - 1;
              return (
                <article key={i} className={`flex gap-3 rounded-xl px-3 pt-3 ${i === 0 ? "bg-accent-soft/40" : ""}`}>
                  <div className="relative flex w-10 shrink-0 flex-col items-center">
                    <MockAvatar />
                    {!last && <div className="absolute -bottom-3 top-11 w-0.5 rounded-full bg-line-strong" />}
                  </div>
                  <div className="min-w-0 flex-1 pb-3">
                    <div className="flex items-center gap-1 text-[14px] leading-5">
                      <span className="truncate font-bold text-ink">You</span>
                      <VerifiedBadge type="blue" size={15} />
                      <span className="truncate text-muted">@you</span>
                      <span className="ml-auto shrink-0 pl-1 text-[11px] tabular-nums text-muted">{i + 1}/{THREAD.length}</span>
                    </div>
                    <p className="tweet-text mt-0.5 text-ink">
                      {post.segments.map((s, j) => (
                        <span key={j} className={s.entity ? "text-accent" : undefined}>{s.text}</span>
                      ))}
                      {i === 0 && <span className="ml-px inline-block h-[18px] w-0.5 translate-y-[3px] animate-pulse bg-accent" />}
                    </p>
                    <div className="mt-2.5 flex items-center justify-between text-muted">
                      <div className="flex max-w-[300px] flex-1 justify-between pr-4">
                        {ACTIONS.map((Icon, k) => <Icon key={k} size={15} />)}
                      </div>
                      <span className="text-[11px] tabular-nums text-faint">{post.count}/280</span>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        {/* Queue */}
        <aside className="hidden w-60 shrink-0 flex-col gap-2 border-l border-line p-4 lg:flex">
          <span className="text-[12px] font-semibold uppercase tracking-wide text-faint">Up next</span>
          {QUEUE.map((q) => (
            <div key={q.text} className="rounded-xl border border-line p-3">
              <div className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
                <IconClock size={13} className="text-schedule" />
                {q.day} · {q.time}
              </div>
              <p className="mt-1 line-clamp-2 text-[12px] text-muted">{q.text}</p>
            </div>
          ))}
          <div className="mt-auto flex items-center gap-1.5 rounded-xl bg-hover px-3 py-2 text-[12px] text-muted">
            <IconSend size={13} /> Publishes automatically
          </div>
        </aside>
      </div>
    </div>
  );
}
