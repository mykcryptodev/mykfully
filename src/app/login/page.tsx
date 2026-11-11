const ERRORS: Record<string, string> = {
  denied: "You cancelled the X authorization.",
  login_failed: "We couldn't complete sign-in with X. Please try again.",
  state_mismatch: "Your login session expired. Please try again.",
  not_allowed: "This X account isn't allowed to sign in here.",
  rate_limited: "Too many sign-in attempts. Please wait a minute and try again.",
  reconnect: "Your X connection expired. Sign in again to reconnect.",
};
const GENERIC_ERROR = "Sign-in failed. Please try again.";

export const metadata = { title: "Sign in · mykfully" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.error) ? sp.error[0] : sp.error;
  // Never reflect the raw query value; unknown codes get a generic message.
  const error = raw ? (Object.hasOwn(ERRORS, raw) ? ERRORS[raw] : GENERIC_ERROR) : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-4 dark:bg-neutral-950">
      <div className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <h1 className="text-center text-2xl font-semibold tracking-tight text-neutral-900 dark:text-white">mykfully</h1>
        <p className="mt-2 text-center text-sm text-neutral-500 dark:text-neutral-400">
          Write, schedule and publish threads on X.
        </p>

        {error && (
          <div
            role="alert"
            className="mt-6 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
          >
            {error}
          </div>
        )}

        {/* Plain link (not next/link): this is a full-page redirect to x.com */}
        <a
          href="/api/auth/login"
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-full bg-black px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-current">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
          Continue with X
        </a>
      </div>
    </main>
  );
}
