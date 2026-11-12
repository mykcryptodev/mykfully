# mykfully architecture (contracts)

Stack: Next.js 15 App Router (TS, Tailwind v4), Drizzle ORM, Postgres (Neon in prod via `DATABASE_URL`; embedded PGlite in `./.data` when unset), pnpm.

## Modules & ownership
| Area | Files |
|---|---|
| Core (shared, do not edit casually) | `src/lib/db/*`, `src/lib/env.ts`, `src/lib/x/types.ts`, `drizzle/*` |
| Auth + X client | `src/lib/crypto.ts`, `src/lib/session.ts`, `src/lib/x/{real,mock,index}.ts`, `src/app/api/auth/**`, `src/app/api/me/route.ts`, `src/app/api/mentions/**`, `src/middleware.ts`, `src/app/login/**` |
| Drafts + scheduler | `src/app/api/drafts/**`, `src/app/api/cron/**`, `src/lib/publisher.ts`, `src/lib/drafts.ts`, `vercel.json`, `src/lib/__tests__/**` |
| Credits + metering | `src/lib/credits.ts`, `src/lib/errors.ts`, `src/lib/http.ts`, `src/lib/ratelimit.ts` (core); `src/lib/x/metered.ts`, `src/app/api/credits/**`, `src/app/api/admin/**` |
| Credit purchases (optional, x402) | `src/lib/payments/*`, `src/app/api/credits/purchase/**`, `scripts/reconcile-purchases.ts`, `src/components/credits/{BuyCreditsModal.tsx,payWithWallet.ts}` |
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
- `POST /api/drafts` `{ posts: { id, text, media?: { id, altText? }[] }[] }` → `{ draft }`. Rate limit `draftCreate` (60/min). Returns 403 `draft_limit` once the user has 500 drafts.
  - A post accepts up to four static images, one GIF, or one MP4. Each attachment must be a completed upload owned by the signed-in user. Alt text is optional and has a 1,000-character limit.
- `GET  /api/drafts/:id` → `{ draft }`
- `PATCH /api/drafts/:id` `{ posts?, scheduledAt?: ISO|null }`. Setting `scheduledAt` sets status to `scheduled`; `null` sets it back to `draft`. Published drafts can't be edited (409). Scheduling runs the publish checks (below).
  - For existing posts, omitting `media` keeps the current attachments and `media: []` clears them. If a failed thread is partially published, posts with a stored tweet ID keep their original attachments.
- `DELETE /api/drafts/:id`
- `POST /api/media` `{ name, contentType, size }` → 201 `{ attachment }`. Starts a chunked upload. Types: JPEG, PNG, WebP (5 MB), GIF (15 MB), MP4 (32 MB). Per-user quota 128 MB / 256 files; unreferenced uploads older than 24h are pruned. Rate limit `mediaStart` (20/min). 413 `media_storage_full` when the quota is used up.
- `PATCH /api/media/:id` `{ offset, data }` (base64, 2 MB chunks, in order) → `{ uploadedSize }`. The first chunk is checked against the file signature (415 on mismatch). Retrying an identical chunk is idempotent. Rate limit `mediaChunk` (120/min).
- `GET /api/media/:id` → the file, owner only, with `Range` support. Rate limit `mediaRead` (180/min).
- Publishing uploads each attachment to X (`/2/media/upload`, chunked for GIF/MP4, alt text via `/2/media/metadata`) immediately before its post, inside a 40s per-post budget. Upload failures happen before `postTweet`, so they are retryable, never `publish_uncertain`. Tokens without the `media.write` scope fail with `reconnect_required`.
- `POST /api/drafts/:id/publish`: publishes now, synchronously and metered → `{ draft }`.
  - No body. Rate limit `publish` (10/min).
  - The publish checks run **before** the draft is claimed.
  - On an X or credit failure, the draft is marked `failed`. The response is the `errorResponse` body plus `draft`, with the same status.
- `GET  /api/credits` → `{ balance, isAdmin, costs: { post, postWithUrl, userRead, mediaUpload, mediaMetadata }, ledger: LedgerEntry[], purchase }` (last 50 rows, ISO dates).
  - `purchase` = `{ enabled, network: "base" | "base-sepolia" | null, chainId, payTo, asset, packs: { id, usd, credits }[] }`. When the feature is off it is `{ enabled: false, …null, packs: [] }`. `payTo`, `asset` and `chainId` let the client pin what it signs.
- `POST /api/credits/purchase` `{ packId }` (optional x402 feature; see "Credit purchases"). Runtime `nodejs`, `maxDuration` 30. Rate limit `purchase` (10/min).
  - Feature off → **404**.
  - No `PAYMENT-SIGNATURE` header → **402** with the x402 v2 challenge in the `PAYMENT-REQUIRED` header (base64 JSON `PaymentRequired`) and body `{ error, code: "payment_required" }`.
  - Payment rejected (doesn't match the pack, fails verification, or settlement definitely failed) → **402** with a fresh challenge and `{ error, code: "payment_rejected", reason }`.
  - Settled → **200** `{ balance, credits, txHash }` plus a `PAYMENT-RESPONSE` header.
  - Outcome unknown → **202** `{ pending: true, purchaseId }`; nothing is credited.
  - Authorization already seen → **409** `payment_replayed`. Transaction already credited to another purchase → **409** `payment_not_credited`. Facilitator unreachable before anything was submitted → **502** `facilitator_unavailable`.
  - **This 402 is the one documented exception to `errorResponse`** (it carries the challenge header), and it does *not* mean `insufficient_credits`. The client therefore calls this route with a bare `fetch`, not `apiFetch`.
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

`LedgerEntry` = `{ id, delta, balanceAfter, kind: signup|grant|revoke|spend|refund|purchase, reason, ref, unmetered, createdAt }`. Admin ledger views also include `actorId`.

`Draft` is a row of the `drafts` table serialized with ISO dates. Post attachments contain `{ id, name, contentType, size, altText? }`, with file metadata supplied by the server.

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
- 1 credit ≈ $0.001 of X spend. `CREDIT_COSTS` are `post` 15, `postWithUrl` 200, `userRead` 10, `mediaUpload` 0 (per X upload request), `mediaMetadata` 5 (per alt-text call) (each overridable with a `CREDIT_COST_*` env var).
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
  - Each unposted post has text or at least one attachment.
  - Each unposted post satisfies `countPost(text, { verifiedType })`: 400 `post_too_long` with `{ index, weighted, max }`.
  - For non-admins, `balance >= estimateThreadCost(posts)` (unposted posts only), otherwise 402 `insufficient_credits` with `{ needed, balance }`.
  - Editing the posts of an already-scheduled draft re-checks content and lengths.

## Credit purchases (optional, x402)
X does not support x402, so this sells the instance's **own** credits for USDC on Base. It never touches the posting path.

- **Enabled only when configured** (`getPurchaseConfig()` in `src/lib/payments/config.ts`, the single source of truth):
  - `PAY_TO_ADDRESS` is a valid non-zero address (mixed-case must pass EIP-55), and
  - `X402_NETWORK` is `base` or `base-sepolia`, and
  - for `base`, `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` are set (CDP facilitator). `base-sepolia` uses `https://x402.org/facilitator`.
  - USDC addresses are hardcoded per network. `PACKS` = `p1` $1 → 1,000, `p5` $5 → 5,000, `p20` $20 → 20,000.
- **Modules** (`src/lib/payments/`):
  - `x402.ts`: lazily builds and initializes the `x402ResourceServer` (cached per config; a failed init isn't cached). `setFacilitatorClient()` injects a facilitator for tests. Builds `PaymentRequirements` per pack **server-side**, decodes and checks the client's payment, and classifies settle outcomes. The CDP facilitator is `HTTPFacilitatorClient` + `generateCdpJwt` (`src/lib/payments/cdpJwt.ts`, jose-based, same JWT format as the CDP SDK; mainnet only). `@x402/next` is not used.
  - `purchases.ts`: `claimPending`, `creditPurchase`, `markFailed`, and `purchaseCredits` (the whole route flow).
  - `reconcile.ts` + `scripts/reconcile-purchases.ts` (`pnpm purchases:reconcile`): manual reconciliation.
- **Table `credit_purchases`:** `id, user_id, pack_id, credits, amount_atomic, network (CAIP-2), asset, pay_to, payer, nonce, status (pending|settled|failed), tx_hash, created_at, settled_at`. Addresses, nonces and hashes are stored lowercase. `UNIQUE(tx_hash)`, `UNIQUE(network, payer, nonce)`.
- **Invariants:**
  - **Never trust the client** for amount, payTo, asset or network. Only `packId` is read from the body. The facilitator always verifies and settles against the server-built requirements, never `payload.accepted`.
  - The payment must be x402 v2, scheme `exact`, an EIP-3009 authorization whose `to`/`value` equal the pack's payTo/amount, valid for at most 5 minutes (`MAX_TIMEOUT_SECONDS`). Permit2 payloads are rejected.
  - **Order:** check → facilitator verify → `claimPending` → facilitator settle → `creditPurchase`.
  - `claimPending` is `INSERT … ON CONFLICT DO NOTHING`; a conflict is a replay and is rejected before settling.
  - `creditPurchase` is **one CTE**: mark the row `settled` with the tx hash (only from `pending`, and only if no row already has that hash), add the credits, and insert a `purchase` ledger row (`ref` = tx hash, `clock_timestamp()`). It credits at most once per purchase and once per transaction; the unique index is the backstop for races.
  - **Credit only on** `success` + the expected network + a 32-byte tx hash. An explicit failure marks the row `failed`. Anything else (timeout, 5xx, `settlement_pending`, odd response) is **uncertain**: return 202 and leave the row `pending`.
- **Reconciliation** (manual in v1): for `pending` rows older than 5 minutes, read USDC `authorizationState(payer, nonce)`.
  - Used → find the `AuthorizationUsed` transaction and credit **only if** the same successful transaction also has `Transfer(payer → pay_to, amount)` from the USDC contract. A used nonce alone is not proof of payment.
  - Unused and older than 6 minutes → `failed` (the authorization has expired).
  - `--include-failed` re-checks failed rows; `--id` + `--tx` checks one purchase against a known transaction.
- **Client** (`src/components/credits/`): `BuyCreditsModal` is loaded with `next/dynamic` when first opened; `payWithWallet.ts` dynamically imports `@x402/core`, `@x402/evm` and `viem` when "Pay with wallet" is pressed. It uses `window.ethereum` only, registers a single network, caps spend at $20, and pins payTo, asset, network and the exact price to what `GET /api/credits` returned. After a signed payment has been sent it never signs again; an unknown outcome is shown as pending. Entry points render only when `purchase.enabled`. No CSP change is needed: the page contacts no new host.
- **The global daily cap applies to spend, not purchases.** Bought credits are still subject to `GLOBAL_DAILY_CREDIT_CAP` when spent; `purchase` rows are not counted as spend.
- **Refunds are manual:** return the USDC yourself and revoke the credits via the admin API.

## Mock mode
`MOCK_X=1` means:
- Login creates the user `@mykdemo` without OAuth.
- `postTweet` returns fake ids and logs to the console.
- `searchUsers` filters a built-in list of ~30 fake users (`@jack`, `@elonmusk`, `@vercel`, `@rauchg`, …).
