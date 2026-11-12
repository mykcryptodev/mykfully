import Link from "next/link";

export const metadata = {
  title: "Privacy · mykfully",
  description: "What mykfully stores and why.",
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <main className="mx-auto max-w-2xl px-5 py-16">
        <Link href="/" className="text-sm text-muted hover:text-ink">
          ← mykfully
        </Link>
        <h1 className="mt-6 text-3xl font-bold tracking-tight">Privacy</h1>
        <p className="mt-4 text-muted">
          mykfully is an independent, open-source tool for writing and scheduling posts on X. It is not affiliated with or endorsed by
          X Corp. The full source code is public on{" "}
          <a href="https://github.com/mykcryptodev/mykfully" target="_blank" rel="noreferrer" className="text-accent hover:underline">
            GitHub
          </a>
          .
        </p>

        <h2 className="mt-10 text-xl font-semibold">Signing in</h2>
        <p className="mt-3 text-muted">
          You sign in through X&apos;s official OAuth 2.0 flow on x.com. mykfully never asks for or receives your X password. X gives
          mykfully an access token limited to the permissions you approve (reading your profile, posting and uploading media on your
          behalf).
        </p>

        <h2 className="mt-10 text-xl font-semibold">What we store</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-muted">
          <li>Your X user id, handle, display name and profile image URL.</li>
          <li>Your X access and refresh tokens, encrypted at rest. They are used only to publish what you schedule.</li>
          <li>Your drafts, scheduled posts and any media you attach to them.</li>
          <li>Your credit balance and a log of credit usage.</li>
          <li>If you buy credits with crypto, the paying wallet address and transaction hash.</li>
          <li>IP addresses, briefly, for rate limiting.</li>
        </ul>
        <p className="mt-3 text-muted">We don&apos;t sell your data, run ads or use third-party trackers.</p>

        <h2 className="mt-10 text-xl font-semibold">Leaving</h2>
        <p className="mt-3 text-muted">
          You can revoke mykfully&apos;s access at any time in your X settings under Security and account access → Apps and sessions.
          After that, mykfully can no longer post for you.
        </p>
      </main>
    </div>
  );
}
