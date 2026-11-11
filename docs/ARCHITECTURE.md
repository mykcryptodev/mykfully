# mykfully architecture (contracts)

Stack: Next.js 15 App Router (TS, Tailwind v4), Drizzle ORM, Postgres (Neon in prod via `DATABASE_URL`; embedded PGlite in `./.data` when unset), pnpm.

## Modules & ownership
| Area | Files |
|---|---|
| Core (shared, do not edit casually) | `src/lib/db/*`, `src/lib/env.ts`, `src/lib/x/types.ts`, `drizzle/*` |
| Auth + X client | `src/lib/crypto.ts`, `src/lib/session.ts`, `src/lib/x/{real,mock,index}.ts`, `src/app/api/auth/**`, `src/app/api/me/route.ts`, `src/app/api/mentions/**`, `src/middleware.ts`, `src/app/login/**` |
| Drafts + scheduler | `src/app/api/drafts/**`, `src/app/api/cron/**`, `src/lib/publisher.ts`, `src/lib/drafts.ts`, `vercel.json`, `src/lib/__tests__/**` |
| Composer UI | `src/app/(app)/**`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`, `src/components/**`, `src/lib/text.ts` |

## Shared function contracts
- `src/lib/session.ts`
  - `getSession(): Promise<{ userId: string } | null>`: reads the signed, httpOnly `myk_session` cookie (jose HS256, `SESSION_SECRET`).
  - `requireUserId(): Promise<string>`: throws `UnauthorizedError` when there is no session. Route handlers map this to 401.
  - `setSession(userId)` / `clearSession()`
- `src/lib/x/index.ts`
  - `getXClientForUser(userId: string): Promise<XClient>`: loads the encrypted tokens and refreshes them if they expire within 2 minutes. The refresh is guarded so concurrent callers don't double-refresh, and the rotated refresh token is persisted. Returns the mock client when `MOCK_X=1`.
- `src/lib/text.ts`
  - `countPost(text): { weighted: number; valid: boolean; max: number }`: uses `twitter-text` `parseTweet`. `max` defaults to 280, or 25000 if the user's `verifiedType` is `blue` and long posts are on.
  - `extractMentions(text): string[]`

## HTTP API (JSON; all require a session except auth + cron)
- `GET  /api/auth/login`: redirects to X OAuth 2.0 PKCE. In mock mode, it logs in as a fake user directly.
- `GET  /api/auth/callback`: exchanges the code, upserts `users` and `x_tokens`, sets the session, redirects to `/`.
- `POST /api/auth/logout`
- `GET  /api/me` → `{ user: { id, username, name, profileImageUrl, verifiedType, timezone } }`
- `PATCH /api/me` `{ timezone }`
- `GET  /api/mentions/search?q=ali` → `{ users: XUser[], source: "search" | "lookup" | "cache" }`
  - Merges the local `mention_cache` (prefix match) with X search, falling back to exact username lookup when search is unavailable on the tier.
  - Upserts the results into the cache.
- `GET  /api/drafts?status=draft|scheduled|published|failed` → `{ drafts: Draft[] }`
- `POST /api/drafts` `{ posts: {id,text}[] }` → `{ draft }`
- `GET  /api/drafts/:id` → `{ draft }`
- `PATCH /api/drafts/:id` `{ posts?, scheduledAt?: ISO|null }`. Setting `scheduledAt` sets status to `scheduled`; `null` sets it back to `draft`. Published drafts can't be edited (409).
- `DELETE /api/drafts/:id`
- `POST /api/drafts/:id/publish`: publishes now, synchronously → `{ draft }`
- `GET  /api/cron/publish` (header `Authorization: Bearer $CRON_SECRET`; Vercel Cron sends this) publishes due drafts.

`Draft` = row of `drafts` table serialized with ISO dates.

## Publishing invariants
- Claim due rows atomically: `UPDATE drafts SET status='publishing', locked_at=now() WHERE status='scheduled' AND scheduled_at <= now() RETURNING *`. Stale `publishing` rows with `locked_at` older than 10 minutes are reclaimable.
- Post the thread sequentially, each post replying to the previous `tweetId`. Persist `posts[i].tweetId` after **each** successful post, and skip posts that already have a `tweetId` on retry.
- On error: set `status='failed'` if `attempts >= 3`, otherwise set it back to `scheduled`; increment `attempts` and record `last_error`.
- After success, bump `mention_cache.use_count` for the @mentions in the thread.

## Mock mode
`MOCK_X=1` means:
- Login creates the user `@mykdemo` without OAuth.
- `postTweet` returns fake ids and logs to the console.
- `searchUsers` filters a built-in list of ~30 fake users (`@jack`, `@elonmusk`, `@vercel`, `@rauchg`, …).
