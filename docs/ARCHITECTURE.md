# mykfully architecture (contracts)

Stack: Next.js 15 App Router (TS, Tailwind v4), Drizzle ORM, Postgres (Neon in prod via `DATABASE_URL`; embedded PGlite in `./.data` when unset), pnpm.

## Modules & ownership
| Area | Files |
|---|---|
| Core (shared, do not edit casually) | `src/lib/db/*`, `src/lib/env.ts`, `src/lib/x/types.ts`, `drizzle/*` |
| Auth + X client | `src/lib/crypto.ts`, `src/lib/session.ts`, `src/lib/x/{real,mock,index}.ts`, `src/app/api/auth/**`, `src/app/api/me/route.ts`, `src/app/api/mentions/**`, `src/middleware.ts`, `src/app/login/**` |
| Drafts + scheduler | `src/app/api/drafts/**`, `src/app/api/cron/**`, `src/lib/publisher.ts`, `src/lib/drafts.ts`, `vercel.json`, `src/lib/__tests__/**` |
| Credits + metering | `src/lib/credits.ts`, `src/lib/errors.ts`, `src/lib/http.ts`, `src/lib/ratelimit.ts` (core); `src/lib/x/metered.ts`, `src/app/api/credits/**`, `src/app/api/admin/**` |
| Composer UI | `src/app/(app)/**`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`, `src/components/**`, `src/lib/text.ts` |

## Shared function contracts
- `src/lib/session.ts`
  - `getSession(): Promise<{ userId: string } | null>`: reads the signed, httpOnly session cookie (jose HS256, `SESSION_SECRET` of at least 32 bytes).
    - The cookie is `__Host-myk_session` in production and `myk_session` in dev.
    - Sessions last 14 days.
    - The JWT carries `ver`, which must equal `users.session_version`. Bumping it (as logout does) revokes every session.
    - The middleware only checks the signature; the APIs enforce the version.
  - `requireUserId(): Promise<string>`: throws `UnauthorizedError` when there is no session. Route handlers map this to 401.
  - `setSession(userId)` / `clearSession()`
- `src/lib/x/index.ts`
  - `getRawXClientForUser(userId): Promise<XClient>`: the **unmetered** client. `getXClientForUser` is a deprecated alias.
    - Loads the encrypted tokens and refreshes them if they expire within 2 minutes.
    - A DB claim (`refreshing_until`) ensures only one refresher runs across instances, and the rotated token is persisted with retries.
    - On `invalid_grant` it sets `needs_reconnect` and throws `ReconnectRequiredError`.
    - Returns the mock client when `MOCK_X=1`.
    - Only use it directly for login-time `me()`; everything else uses `getMeteredXClient`.
- `src/lib/x/metered.ts`
  - `getMeteredXClient(userId, ref?)`: the raw client (`getRawXClientForUser`) wrapped by `meter(db, client, userId, ref)`. **Every** user-initiated or scheduled X call goes through it. Only the login-time `me()` uses the raw client.
- `src/lib/errors.ts`
  - `toPublicError(e)` / `errorResponse(e)`: the only way errors reach clients. The body is `{ error, code, ...extra }`, and unknown errors become `internal_error`.
- `src/lib/http.ts`
  - Mutating routes call `assertSameOrigin(req)` first. Routes with a body also call `assertJson(req)`.
  - Credit-spending GET routes (`/api/mentions/search`) call `assertSameSiteFetch(req)`: `Sec-Fetch-Site: same-origin`, or, if that header is absent, a Referer on APP_URL. Otherwise 403.
  - `clientIp(req)` prefers `x-vercel-forwarded-for`, then `x-real-ip`, then the first `x-forwarded-for` entry.
- `src/lib/text.ts`
  - `countPost(text): { weighted: number; valid: boolean; max: number }`: uses `twitter-text` `parseTweet`. `max` defaults to 280, or 25000 if the user's `verifiedType` is `blue` and long posts are on.
  - `extractMentions(text): string[]`

## HTTP API (JSON; all require a session except auth + cron)
Errors are `{ error: string, code: string, ...extra }` (see `errorResponse`). Mutating routes return 403 on a cross-origin `Origin`/`Referer`, and 415 when a body route doesn't send `application/json`.
- `GET  /api/auth/login`: redirects to X OAuth 2.0 PKCE. In mock mode, it logs in as a fake user directly.
- `GET  /api/auth/callback`: exchanges the code, upserts `users` and `x_tokens`, sets the session, redirects to `/`.
  - Rate limit `callback` (20/min per IP) → `/login?error=rate_limited`.
  - If `ALLOWED_X_USER_IDS` is set, other X users (admins excepted) are redirected to `/login?error=not_allowed` before any DB write.
- `POST /api/auth/logout`: POST only (GET was removed). Same-origin checked, and it bumps `session_version`.
- `GET  /api/me` → `{ user: { id, xUserId, username, name, profileImageUrl, verifiedType, timezone, credits, isAdmin, needsReconnect } }`. `needsReconnect` comes from `x_tokens`; it's false in mock mode or when there's no row.
- `PATCH /api/me` `{ timezone }`
- `GET  /api/mentions/search?q=ali` → `{ users: XUser[], source: "search" | "lookup" | "cache", creditsExhausted?: true }`
  - Merges the local `mention_cache` (prefix match) with metered X search.
  - X is called only when `q.length >= 2` **and** the cache has fewer than 5 prefix matches.
  - Rejects cross-site requests with 403 (`assertSameSiteFetch`).
  - Rate limit `search` (30/min per user) on every request → 429. Per-process memo hits are never charged.
  - On insufficient credits or the daily cap, returns cache-only results with `creditsExhausted: true`.
  - The exact-username lookup fallback runs only on `XSearchUnavailableError` or an X 4xx other than 429.
  - Upserts the X results into the cache.
- `GET  /api/drafts?status=draft|scheduled|published|failed` → `{ drafts: Draft[] }`. Returns at most 200, newest `updated_at` first.
- `POST /api/drafts` `{ posts: {id,text}[] }` → `{ draft }`. Rate limit `draftCreate` (60/min). Returns 403 `draft_limit` once the user has 500 drafts.
- `GET  /api/drafts/:id` → `{ draft }`
- `PATCH /api/drafts/:id` `{ posts?, scheduledAt?: ISO|null }`. Setting `scheduledAt` sets status to `scheduled`; `null` sets it back to `draft`. Published drafts can't be edited (409). Scheduling runs the publish checks (below).
- `DELETE /api/drafts/:id`
- `POST /api/drafts/:id/publish`: publishes now, synchronously and metered → `{ draft }`.
  - No body. Rate limit `publish` (10/min).
  - The publish checks run **before** the draft is claimed.
  - On an X or credit failure, the draft is marked `failed`. The response is the `errorResponse` body plus `draft`, with the same status.
- `GET  /api/credits` → `{ balance, isAdmin, costs: { post, postWithUrl, userRead }, ledger: LedgerEntry[] }` (last 50 rows, ISO dates).
- `GET  /api/cron/publish` (header `Authorization: Bearer $CRON_SECRET`; Vercel Cron sends this) publishes due drafts with each owner's metered client → `{ processed, results: { id, status, error? }[] }`, where `error` uses the `last_error` format.

### Admin API
For admins only (`ADMIN_X_USER_IDS`). Everyone else gets **404**, so the surface isn't revealed. Rate limit `admin` (60/min).
- `GET  /api/admin/users` → `{ users: { id, username, name, profileImageUrl, credits, isAdmin, spent7d, spent30d, createdAt, lastSeen }[] }`
  - Ordered by `updated_at` desc, max 500. `lastSeen` = `users.updated_at`.
  - `spentNd` = net metered (`spend` + `refund`, `unmetered = false`) ledger delta over N days. Admins' unmetered spend is excluded.
- `GET  /api/admin/users/:id/ledger` → `{ ledger: LedgerEntry[] }` (last 200 rows).
- `POST /api/admin/credits` `{ userId, delta: int (non-zero, |delta| ≤ 10,000,000), reason: string 1..200 }` → `{ balance }`
  - A negative delta is a revoke, and the balance is clamped at 0.
  - Returns 404 for an unknown user.

`LedgerEntry` = `{ id, delta, balanceAfter, kind: signup|grant|revoke|spend|refund, reason, ref, unmetered, createdAt }`. Admin ledger views also include `actorId`.

`Draft` = row of `drafts` table serialized with ISO dates.

## Publishing invariants
- Claim due rows atomically: `UPDATE drafts SET status='publishing', locked_at=now() WHERE status='scheduled' AND scheduled_at <= now() RETURNING *`. Stale `publishing` rows with `locked_at` older than 10 minutes are reclaimable.
- Post the thread sequentially, each post replying to the previous `tweetId`. Persist `posts[i].tweetId` after **each** successful post, and skip posts that already have a `tweetId` on retry.
- On error: increment `attempts` and record `last_error`. Set `status='failed'` if `attempts >= 3`, otherwise set it back to `scheduled`.
  - **Fatal** errors (`isFatalPublishError`) go straight to `failed` with no retry: insufficient credits, the daily cap, reconnect required, X 401/403, and `publish_uncertain` (`AmbiguousPublishError`).
  - `publish_uncertain` means X may have published the post (network error, timeout, 5xx, bad 2xx body, or the tweetId couldn't be saved after 3 tries). It is never retried automatically, to avoid double posts.
  - Already-posted `tweetId`s are always kept, so re-scheduling or publishing after a top-up resumes the thread.
- `last_error` is **always** `[code] message` built from `toPublicError`, never a raw message. Examples:
  - `[insufficient_credits] Not enough credits (need 15, have 5)`
  - `[reconnect_required] Your X connection expired. Reconnect X to keep publishing.`
  - `[x_api_error] X API error 503: Service Unavailable`
  - `[internal_error] Something went wrong`
  - Parse it with `/^\[(\w+)\] (.*)$/`.
- After success, bump `mention_cache.use_count` for the @mentions in the thread.

## Credits
- 1 credit ≈ $0.001 of X spend. `CREDIT_COSTS` are `post` 15, `postWithUrl` 200, `userRead` 10 (each overridable with a `CREDIT_COST_*` env var).
- New users get `SIGNUP_CREDITS` (default 1000) once.
- `GLOBAL_DAILY_CREDIT_CAP` caps non-admin spend per rolling 24h (default 20000; 0 disables it).
- Existing users with no `signup` ledger row (created before credits existed) get the signup grant on their next login.
- Admins are unlimited; their spend is logged with `unmetered = true`.
- Metering (`meter()`) is active in mock mode too:
  - `postTweet`: debit `postCost(text)` before the call. Refund only on a definite X rejection (4xx except 408; 429 is refunded). Any other failure is not refunded and throws `AmbiguousPublishError`.
  - `searchUsers(q, max)`: `max` is clamped to 8. Reserve `max × userRead`, then refund the users not returned (the full amount if the call throws).
  - `lookupUsernames(names)`: reserve per name, then refund the names not found.
  - `me()`: free.
- Publish checks run on schedule (`scheduledAt` set) and on publish-now, via `assertReadyToPublish`:
  - No empty posts.
  - Each unposted post satisfies `countPost(text, { verifiedType })`: 400 `post_too_long` with `{ index, weighted, max }`.
  - For non-admins, `balance >= estimateThreadCost(posts)` (unposted posts only), otherwise 402 `insufficient_credits` with `{ needed, balance }`.
  - Editing the posts of an already-scheduled draft re-checks lengths only.

## Mock mode
`MOCK_X=1` means:
- Login creates the user `@mykdemo` without OAuth.
- `postTweet` returns fake ids and logs to the console.
- `searchUsers` filters a built-in list of ~30 fake users (`@jack`, `@elonmusk`, `@vercel`, `@rauchg`, …).
