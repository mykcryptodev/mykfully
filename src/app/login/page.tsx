import type { ReactNode } from "react";
import { ProductPreview } from "@/components/landing/ProductPreview";
import { IconCalendar, IconEye, IconHash, IconPen, IconShield, IconUndo } from "@/components/ui/icons";
import { env } from "@/lib/env";

const ERRORS: Record<string, string> = {
  denied: "You cancelled the X authorization.",
  login_failed: "We couldn't complete sign-in with X. Please try again.",
  state_mismatch: "Your login session expired. Please try again.",
  not_allowed: "This X account isn't allowed to sign in here.",
  rate_limited: "Too many sign-in attempts. Please wait a minute and try again.",
  reconnect: "Your X connection expired. Sign in again to reconnect.",
};
const GENERIC_ERROR = "Sign-in failed. Please try again.";

export const metadata = {
  title: "mykfully · Write, schedule and publish threads on X",
  description: "A distraction-free editor for X threads. Write with a live preview, schedule for later and let mykfully publish on time.",
};

const FEATURES: { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <IconPen size={20} />,
    title: "An editor built for threads",
    body: "Write the whole thread in one place. Press ⌘ Enter to add a post, or type three line breaks to split one. Reorder posts with Option ↑ and ↓.",
  },
  {
    icon: <IconHash size={20} />,
    title: "Counts like X counts",
    body: "The character counter uses X's own twitter-text rules, so links, emoji and long posts are measured exactly. Overflow is highlighted before you post.",
  },
  {
    icon: <IconEye size={20} />,
    title: "See it before they do",
    body: "A live preview shows your thread as it will look on X, on desktop or mobile. @mentions autocomplete from real X accounts.",
  },
  {
    icon: <IconCalendar size={20} />,
    title: "Schedule and forget",
    body: "Pick a time in your own timezone. A scheduler checks every minute and publishes each post as a reply to the one before it.",
  },
  {
    icon: <IconUndo size={20} />,
    title: "Drafts that never get lost",
    body: "Everything autosaves as you type. If publishing fails halfway, mykfully resumes from where it stopped instead of posting twice.",
  },
  {
    icon: <IconShield size={20} />,
    title: "Your account stays yours",
    body: "Sign in with X OAuth. We never see your password, tokens are encrypted at rest, and the code is open source.",
  },
];

const STEPS = [
  { title: "Sign in with X", body: "One click. No password, no email form." },
  { title: "Write your thread", body: "Draft, preview and polish in a calm, focused editor." },
  { title: "Schedule it", body: "Choose a time. mykfully posts it for you." },
];

function XLogo({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={`${className} fill-current`}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function SignInButton({ size = "lg" }: { size?: "sm" | "lg" }) {
  const sizing = size === "lg" ? "px-6 py-3 text-[15px]" : "px-4 py-2 text-sm";
  return (
    // Plain link (not next/link): this is a full-page redirect to x.com
    <a
      href="/api/auth/login"
      className={`inline-flex items-center justify-center gap-2 rounded-full bg-ink font-semibold text-canvas transition-opacity hover:opacity-85 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas ${sizing}`}
    >
      <XLogo />
      Continue with X
    </a>
  );
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.error) ? sp.error[0] : sp.error;
  // Never reflect the raw query value; unknown codes get a generic message.
  const error = raw ? (Object.hasOwn(ERRORS, raw) ? ERRORS[raw] : GENERIC_ERROR) : null;
  const signupCredits = env.signupCredits;

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="sticky top-0 z-20 border-b border-line bg-canvas/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <span className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="mykfully logo" width={32} height={32} className="h-8 w-8 rounded-lg" />
            <span className="text-lg font-bold tracking-tight">mykfully</span>
          </span>
          <SignInButton size="sm" />
        </div>
      </header>

      <main>
        <section className="relative overflow-hidden px-5 pt-16 sm:pt-24">
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-0 h-[520px] bg-gradient-to-b from-accent-soft to-transparent" />
          <div className="relative mx-auto max-w-3xl text-center">
            <p className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-line-strong bg-canvas px-3 py-1 text-[13px] text-muted">
              <XLogo className="h-3 w-3" /> Made for writing on X
            </p>
            <h1 className="text-balance text-4xl font-extrabold leading-[1.08] tracking-tight sm:text-6xl">
              Write threads people finish reading.
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-pretty text-lg text-muted">
              mykfully is a calm, focused editor for X. Draft your thread, see exactly how it will look, and schedule it to post while you get on with your day.
            </p>

            {error && (
              <div
                role="alert"
                className="mx-auto mt-6 max-w-md rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
              >
                {error}
              </div>
            )}

            <div className="mt-8 flex flex-col items-center gap-3">
              <SignInButton />
              <p className="text-[13px] text-faint">
                {signupCredits > 0 ? "Free to start. New accounts get starter credits." : "Sign in with your X account to get started."}
              </p>
            </div>
          </div>

          <div className="relative mx-auto mt-14 max-w-6xl sm:mt-20">
            <ProductPreview />
          </div>
        </section>

        <section className="px-5 py-24">
          <div className="mx-auto max-w-6xl">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Everything you need to post well, nothing you don&apos;t</h2>
              <p className="mt-4 text-muted">No feeds, no notifications, no noise. Just you and what you want to say.</p>
            </div>
            <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <div key={f.title} className="rounded-2xl border border-line bg-card p-6">
                  <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent">{f.icon}</div>
                  <h3 className="text-[17px] font-semibold">{f.title}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-muted">{f.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-y border-line bg-sidebar px-5 py-24">
          <div className="mx-auto max-w-5xl">
            <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">From idea to posted in three steps</h2>
            <ol className="mt-14 grid gap-8 sm:grid-cols-3">
              {STEPS.map((s, i) => (
                <li key={s.title} className="text-center">
                  <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-ink text-sm font-bold text-canvas">
                    {i + 1}
                  </span>
                  <h3 className="mt-4 text-lg font-semibold">{s.title}</h3>
                  <p className="mt-1.5 text-muted">{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="px-5 py-28">
          <div className="mx-auto max-w-2xl text-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="" width={64} height={64} className="mx-auto mb-6 h-16 w-16 rounded-2xl" />
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Your next thread starts here</h2>
            <p className="mt-4 text-muted">Sign in with X and write your first draft in under a minute.</p>
            <div className="mt-8">
              <SignInButton />
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line px-5 py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 text-[13px] text-faint sm:flex-row">
          <span>© mykfully</span>
          <a href="https://github.com/mykcryptodev/mykfully" target="_blank" rel="noreferrer" className="hover:text-ink">
            Open source on GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}
