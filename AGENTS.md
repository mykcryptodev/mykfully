# AGENTS.md: mykfully

Guidance for AI coding agents (and humans) working in this repo. Read it before you change anything. The repo is **public**, it touches **real money** (X API spend) and **posts to real X accounts**.

Other docs: `README.md` covers user-facing setup. `docs/ARCHITECTURE.md` holds the API contracts and invariants. Where those docs and the code disagree, **the code wins** (see "Doc drift" at the end).

---

## 1. What this is

mykfully is a self-hosted, open-source Typefully clone for X (Twitter). It has three core features:

1. **Log in with X.** OAuth 2.0 with PKCE. Tokens are encrypted at rest and refreshed automatically, so scheduled posts keep working.
2. **An X-style thread composer.**
   - Live @mention, #hashtag and URL highlighting.
   - The real `twitter-text` weighted counter.
   - @mention autocomplete backed by X user search.
   - An X-like preview and autosaved drafts.
3. **Scheduling and publishing.**
   - A Vercel Cron job runs every minute and publishes due threads.
   - Publishing is resumable and safe against double-posting.

All paid X calls are metered by a per-user **credit system** (1 credit ≈ $0.001 of X spend). The ledger is append-only, there is an admin grant page, and there is an optional instance-wide daily cap.

## 2. Tech stack

- **Next.js 15.5 App Router** with React 19, TypeScript (strict) and Tailwind CSS v4 (`@tailwindcss/postcss`, tokens in `globals.css`).
- **Drizzle ORM and Postgres:**
  - Prod: **Neon** via `drizzle-orm/neon-http` (HTTP driver, **no transactions**).
  - Local and tests: **PGlite**, an embedded Postgres in WASM.
- **Auth and validation:** `jose` (HS256 session JWT), `zod` v4 (request validation), `twitter-text` (counting, entities).
- **Tests and package manager:** vitest 5 and pnpm 10.

## 3. Directory map

```
src/
  middleware.ts            Edge: signature-only session check → redirect to /login (no DB; keep cookie name in sync with session.ts)
  app/
    layout.tsx, globals.css   Root layout; X-like color tokens + dark mode + composer mirror CSS
    login/page.tsx            Login page (whitelisted ?error= codes)
    (app)/layout.tsx          Wraps everything in <AppShell> (Composer lives in the layout, not pages)
    (app)/page.tsx, drafts/[id]/page.tsx   Return null; the composer reads the route
    (app)/admin/page.tsx      <AdminPage/>
    api/
      auth/{login,callback,logout}/route.ts
      me/route.ts             GET profile+credits, PATCH timezone
      drafts/route.ts, drafts/[id]/route.ts, drafts/[id]/publish/route.ts
      mentions/search/route.ts   Paid GET (credit-spending) mention search
      credits/route.ts        Balance, costs, last 50 ledger rows
      cron/publish/route.ts   Bearer CRON_SECRET; runs runDuePublishing
      admin/_lib.ts           requireAdmin (404 for non-admins), serializeLedger, listUsersWithSpend
      admin/{users,users/[id]/ledger,credits}/route.ts
  lib/                     Server-side domain logic (route handlers stay thin)
    __tests__/             vitest suites + auth-helpers.ts
  components/              Client UI (see §9)
drizzle/                   Generated SQL migrations + meta/ (journal, snapshots)
scripts/migrate.mjs        Neon migrations, run by `pnpm build`
docs/ARCHITECTURE.md       API contracts and invariants
next.config.ts             CSP + security headers; pglite in serverExternalPackages
vercel.json                Cron: /api/cron/publish every minute
pnpm-workspace.yaml        minimumReleaseAge + postcss override
```

### Key modules in `src/lib/`

| Module | Responsibility |
|---|---|
| `env.ts` | The central place for reading `process.env`, plus `intEnv`. A few files read it directly: `middleware.ts` (Edge), `db/index.ts` (`PGLITE_DIR`), `x/mock.ts` (`MOCK_X_FAIL_AFTER`) and `next.config.ts`. Getters are lazy, so a missing var throws on first use, not at import. `mockX` is forced off when `VERCEL_ENV=production`. `allowMockLogin` exists for `pnpm start` smoke tests. |
| `db/schema.ts` | Drizzle tables: `users`, `x_tokens`, `drafts` (posts are `jsonb` `ThreadPost[]`), `mention_cache`, `credit_ledger`, `rate_limits`, `credit_purchases` (x402). |
| `db/index.ts` | `getDb()`: Neon when `DATABASE_URL` is set, otherwise PGlite in `PGLITE_DIR` (default `./.data/pglite`), migrated on startup. The promise is cached on `globalThis.__mykDb`, so a failed init stays failed until the process restarts. |
| `session.ts` | `getSession` / `requireUserId` / `setSession` / `clearSession` / `revokeSessions`. Sessions are HS256 JWTs with a `ver` claim that must match `users.session_version`. The cookie is `__Host-myk_session` in prod and `myk_session` in dev. They last 14 days. |
| `crypto.ts` | AES-256-GCM `encrypt(plaintext, aad)` / `decrypt`. Format `v2:` uses AAD = userId; `v1:` is legacy and read-only. |
| `x/types.ts` | The `XClient` interface (`me`, `postTweet`, `lookupUsernames`, `searchUsers`), `XUser`, `XApiError` and `XSearchUnavailableError`. |
| `x/real.ts` | `createRealXClient(accessToken)` (fetch to `api.x.com/2`, with a timeout), `xTokenRequest` and `XTokenError`. |
| `x/mock.ts` | `createMockXClient()`: fake ids and about 30 seeded users. Login user is `MOCK_ME` (`@mykdemo`). `MOCK_X_FAIL_AFTER=n` fails the nth post. |
| `x/index.ts` | OAuth helpers (`X_SCOPES`, `exchangeAuthCode`, `redirectUri`), `upsertUser` (signup grant), `saveTokens`, the **DB-claimed token refresh**, `getRawXClientForUser` and `mockLogin`. |
| `x/metered.ts` | `meter(db, client, userId, ref)` and **`getMeteredXClient(userId, ref?)`**, which apply credit debit and refund around each X call. `SEARCH_MAX = 8`. |
| `credits.ts` | `CREDIT_COSTS`, `postCost`, `estimateThreadCost`, `debit` / `refund` / `grant` / `grantSignup`, `listLedger`, `isAdmin`, and `execRows`. |
| `ratelimit.ts` | A fixed-window limiter in Postgres. `LIMITS` sets the limits; call it with `limitNamed(db, name, subject)`. |
| `errors.ts` | `HttpError` and the typed domain errors, plus `isFatalPublishError`, **`toPublicError`** and **`errorResponse`**. |
| `http.ts` | `assertSameOrigin`, `assertSameSiteFetch`, `assertJson` and `clientIp`. |
| `drafts.ts` | Zod input schemas, plus user-scoped CRUD and the `assertReadyToPublish` checks (empty posts, lengths, credits). `serializeDraft` converts dates to ISO strings. |
| `publisher.ts` | `claimDueDrafts`, `publishDraft`, `markPublished`, `markFailed`, `runDuePublishing` and `publicErrorText`. |
| `payments/` | **Optional x402 credit purchases** (USDC on Base). `config.ts` validates `PAY_TO_ADDRESS` / `X402_NETWORK` / CDP keys; the feature is off unless they are valid. `x402.ts` builds the resource server and server-side `PaymentRequirements` (facilitator injectable for tests). `cdpJwt.ts` signs CDP API-key JWTs with jose. `purchases.ts` claims a pending row on (network, payer, nonce), then credits in one CTE with a unique `tx_hash`. `reconcile.ts` + `pnpm purchases:reconcile` settle stuck pending rows from chain state. |
| `text.ts` | Pure `twitter-text` helpers, safe on both client and server: `countPost`, `overflowIndex`, `tokenize`, `splitIntoThread`, `extractMentions`, `hasUrl`. Long posts (25k) are allowed for `premium` / `blue`. |

## 4. Setup and commands

**Use pnpm only.** Never use npm or yarn, and never commit a `package-lock.json` or `yarn.lock`.

- `pnpm-workspace.yaml` sets **`minimumReleaseAge: 1440`**: a package version must be at least 24 hours old before it can be installed. **Never bypass or lower this.** No `--config.minimumReleaseAge=0`, no editing the file, no switching package managers. If a fresh version is required, wait or pin an older one.
- `overrides: postcss: ">=8.5.23"` is a security pin, which keeps `pnpm audit` clean. Keep it.
- `packageManager` is `pnpm@10.25.0`.

| Command | What it does |
|---|---|
| `pnpm install` | Installs dependencies. |
| `pnpm dev` | Runs the Next dev server with whatever `.env.local` says (PGlite when `DATABASE_URL` is empty). |
| `pnpm dev:local` / `dev:preview` / `dev:prod` | Runs `next dev` against an explicit database. See "Choosing a database" below. |
| `pnpm typecheck` | Runs `tsc --noEmit`. |
| `pnpm lint` | Runs ESLint (`next/core-web-vitals` and `next/typescript`). |
| `pnpm test` | Runs `vitest run`: 10 files and about 94 tests, about 10 seconds. |
| `pnpm build` | Runs `node scripts/migrate.mjs && next build`. **Unset `DATABASE_URL` locally** unless you really mean to migrate that database. |
| `pnpm db:generate` | Runs `drizzle-kit generate` from `schema.ts` into `drizzle/`. No DB is needed. |
| `pnpm db:migrate` | Runs `drizzle-kit migrate` against `DATABASE_URL`. Rarely needed, since the build and startup already migrate. |

### Run locally: mock X and PGlite (no X account needed)

```bash
cp .env.example .env.local      # .env* is gitignored (except .env.example)
openssl rand -hex 32            # → paste the output as SESSION_SECRET (≥ 32 bytes, else middleware returns 500)
openssl rand -base64 32         # → TOKEN_ENCRYPTION_KEY (must decode to exactly 32 bytes)
openssl rand -hex 32            # → CRON_SECRET
# also set MOCK_X=1 and leave DATABASE_URL empty (→ PGlite in ./.data/pglite)
pnpm dev
```

.env files don't run shell commands. Paste each command's literal output; don't write `KEY=$(openssl …)`.

> **Owner's machine:** the pulled production env lives in `.env.neon-production`, which Next does **not** load. Never source it for dev or tests, and never rename it back to `.env.local`.
>
> **Warning: `.env.local` may point at a real database.** `vercel env pull` writes `.env.local` from the Vercel **Development** environment. Its `DATABASE_URL` is the shared **preview** database (`mykfully_preview`), not prod, but an older pull, or a pull with `--environment=production`, holds the **production** URL. Next loads `.env.local` in `dev`, `start` and `build`. `getDb()` prefers `DATABASE_URL` over PGlite, and `PGLITE_DIR` is ignored when it is set. Mock mode is **not** blocked locally, so a mock login writes a `mock-1` user to whichever DB is configured. Before running locally, check `grep -c '^DATABASE_URL=.' .env.local`. Variables already in the shell take precedence over .env files.

#### Choosing a database

`scripts/dev-db.mjs` runs `next dev` with `DATABASE_URL` set in the environment, which overrides `.env.local`. Every other variable still comes from `.env.local`.

| Command | Database | Notes |
|---|---|---|
| `pnpm dev:local` | PGlite in `./.data/pglite` | Ignores any `DATABASE_URL` in `.env.local`. |
| `pnpm dev:preview` | The shared preview DB (Vercel Preview env) | Runs `scripts/migrate.mjs` first, as a preview build does. Safe for mock login and unmerged migrations, but other previews share it. |
| `pnpm dev:prod` | **Production** (Vercel Production env) | Never migrates. Forces `MOCK_X=0` and `ALLOW_MOCK_LOGIN=0`, so mock users can't land in prod. Real X login needs the prod `X_CLIENT_ID`/`X_CLIENT_SECRET`, plus the prod `TOKEN_ENCRYPTION_KEY` to read stored tokens, in `.env.local`, and `http://localhost:3000/api/auth/callback` registered on the X app. Treat everything you do here as real. |

- The URL is pulled with `vercel env pull` (logged in, project linked) and cached in `.env.db.preview` / `.env.db.prod` (mode 600, gitignored by `.env*`). Each file holds only `DATABASE_URL`; the other pulled secrets are deleted.
- Add `--refresh` to re-pull. Any other arguments go to `next dev` (e.g. `pnpm dev:preview -p 3001`).
- Agents: never run `dev:prod` unless the user asks for it.

- **Mock login:** open http://localhost:3000/api/auth/login, or click "Continue with X". Either signs you in as `@mykdemo` (id `mock-1`) with `SIGNUP_CREDITS` credits.
- `X_CLIENT_ID` isn't needed in mock mode.
- Set `ADMIN_X_USER_IDS=mock-1` to test `/admin` and unlimited credits.
- **Scratch DB:** set `PGLITE_DIR=/some/tmp/dir` to use a throwaway database. To reset local data, stop the server and delete `./.data`.
- **`pnpm start` smoke test (production mode):** mock login is refused under `NODE_ENV=production` unless `ALLOW_MOCK_LOGIN=1` is set.
  - Use it locally or on a Preview deployment (see §10 "Preview deployments"). **Never** set it on Production.
  - Prod cookies are `__Host-`/`Secure`. Curl accepts them on `localhost`.
  - `APP_URL` must match the port, or login redirects to `:3000` and the origin checks reject every mutating request.

  ```bash
  pnpm build && DATABASE_URL= MOCK_X=1 ALLOW_MOCK_LOGIN=1 APP_URL=http://localhost:3123 PGLITE_DIR=/tmp/myk-smoke pnpm start -p 3123
  ```
- **Stopping servers:** `pkill -f "next start"` doesn't match the `next-server` process. Kill by port instead: `lsof -ti :3123 | xargs kill`.
- **Trigger the cron job locally:**

  ```bash
  curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/publish
  # → {"processed":N,"results":[{id,status,error?}]}   (401 without/with wrong secret)
  ```
- **Mutating routes from curl** need `-H "origin: http://localhost:3000" -H "content-type: application/json"` plus the session cookie (`-c jar` on login, then `-b jar`).

## 5. Testing

- **What they cover:** vitest tests in `src/lib/__tests__/*.test.ts` (node environment, 30s timeout, `@` aliased to `src`). They hit a **fresh in-memory PGlite per test**, migrated from `./drizzle`, so they never touch `./.data`.
- **Patterns to copy:**
  - **Inject the DB directly** (`drafts.test.ts`, `credits.test.ts`, `publisher.test.ts`):

    ```ts
    const d = drizzle(new PGlite(), { schema });
    await migrate(d, { migrationsFolder: "./drizzle" });
    db = d as unknown as DB;
    ```
  - **Install it as the `getDb()` singleton:** `installTestDb()` and `setAuthEnv()` in `__tests__/auth-helpers.ts`. These set test keys, delete `MOCK_X` and clear the refresh map.
  - **Mock `next/headers`**, because any import of `session.ts` needs it:

    ```ts
    vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {} }) }));
    ```

    `auth-session.test.ts` has a `vi.hoisted` cookie jar for real round-trips.
  - **Route-handler tests** (`admin.test.ts`) mock `@/lib/db` and `@/lib/session`, then call the exported `GET`/`POST` with a `new Request(...)` that carries `origin` and `content-type` headers.
  - **Fake X:** a small `class FakeX implements XClient`, wrapped with `meter(db, fake, userId)` to test billing.
- **Env cleanup:** reset env you touch in `afterEach`, such as `ADMIN_X_USER_IDS`, `SIGNUP_CREDITS` and `GLOBAL_DAILY_CREDIT_CAP`. `env.ts` reads lazily, so setting `process.env` inside a test works.
- **Before every commit, all four must pass:**

  ```bash
  pnpm typecheck && pnpm lint && pnpm test && pnpm build
  ```
- Add tests with any change to credits, metering, publishing, drafts, sessions, crypto or token refresh.

## 6. Database

- **Schema changes:** edit `src/lib/db/schema.ts`, run `pnpm db:generate`, review the SQL, then commit the SQL and `drizzle/meta/*` together.
- **Never hand-edit an applied migration** (`0000_init`, `0001_credits_and_hardening`, …) or the journal. To fix one, write a new migration.
- **When migrations run:**
  - Prod (Neon): `scripts/migrate.mjs` runs before `next build` on Vercel. It is a no-op when `DATABASE_URL` is unset.
  - Local and tests (PGlite): `getDb()` runs `migrate()` on first use.
  - Migrations must work on both drivers, so use plain Postgres SQL.
- **`neon-http` has NO transactions.** Never use `db.transaction(...)`. It fails in prod even though PGlite accepts it. Make multi-step writes atomic in **one statement** instead:
  - `UPDATE … WHERE <guard> RETURNING`, as in the status-guarded draft updates and claims and the refresh claim.
  - Data-modifying CTEs: `WITH d AS (UPDATE … RETURNING) INSERT INTO credit_ledger … SELECT … FROM d`. See `debit`, `refund` and `grant`.
  - `FOR UPDATE` inside a CTE, so a read-modify-write is exact (`grant`).
  - `jsonb_set` for in-place updates of one jsonb field (`persistTweetId`).
- **Row shapes from `db.execute`:** raw `db.execute(sql\`…\`)` results differ by driver. They come back as `{ rows }` or a bare array, and column names stay **snake_case**. Always wrap the result in `execRows<T>(res)` from `credits.ts`. Coerce numbers with `Number(...)`, because `int`/`bigint` can arrive as strings.
- Prefer the Drizzle query builder. Use `sql` template interpolation for values, and never string-concatenate SQL.

## 7. Critical invariants and security rules

Breaking any of these causes double posts, lost money, account takeover or data leaks. If a change seems to require breaking one, stop and ask.

1. **Every X call goes through the metered client.** Use `getMeteredXClient(userId, ref)` in `x/metered.ts`. `getRawXClientForUser` (and its deprecated alias `getXClientForUser`) is unmetered. The *only* legitimate raw use is the login-time `me()`: the callback uses `createRealXClient(tokens.accessToken).me()` before the user exists. Reason: unmetered calls spend the operator's real money with no limit and no ledger record.
2. **Credit semantics:**
   - `debit` checks the balance, decrements it and inserts a ledger row in a single CTE. It throws `InsufficientCreditsError` (402) or `CreditCapReachedError` (503, when `GLOBAL_DAILY_CREDIT_CAP` is exceeded over a rolling 24h).
   - Admins are never charged, but their spend is logged with `unmetered = true` and excluded from the cap and from admin spend stats.
   - `refund` adds credits back with kind `refund`.
   - `grant` handles admin grants and revokes; the balance is clamped at 0 and the ledger stores the *actual* delta.
   - `credit_ledger` is **append-only**: never update or delete its rows. Each row stores `balance_after`. Order by `seq`, because timestamps can tie.
   - Search and lookup *reserve* the maximum cost up front, then refund the unused part.
3. **Refunds happen only on a definite X rejection.** `postTweet` debits *before* the call. It refunds only on an `XApiError` 4xx other than 408 (429 is refunded). Anything else (network error, timeout, 5xx, a bad 2xx body) means **X may have posted**, so `meter` throws `AmbiguousPublishError` (`publish_uncertain`, 502) and does not refund. `publish_uncertain` is fatal: the draft goes to `failed` and is never auto-retried.
4. **Publisher claim and resume** (`publisher.ts`):
   - **Claiming:** `claimDueDrafts` moves rows to `publishing` with an `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`, so concurrent cron runs never claim the same draft. Rows stuck in `publishing` for more than 10 minutes can be claimed again. Publish-now claims with a status-guarded `UPDATE … RETURNING` *after* `assertReadyToPublish`, so a 400 or 402 never strands a draft in `publishing`.
   - **Posting:** posts go out sequentially, each replying to the previous `tweetId`. `persistTweetId` saves each `tweetId` **immediately after its post**, retrying 3 times. If it still fails, it throws `AmbiguousPublishError`. Posts that already have a `tweetId` are skipped, which is how a failed thread resumes.
   - **Failure handling:** `markFailed` increments `attempts`, retries (back to `scheduled`) until `MAX_ATTEMPTS = 3`, and fails immediately on fatal errors (`isFatalPublishError`: credits, the cap, reconnect, X 401/403, `publish_uncertain`). Publish-now failures are always final.
   - **Never trust a client `tweetId`.** Zod strips it, and `mergePosts` keeps the server-side values.
5. **Scope user-facing draft queries by `userId`:** `and(eq(drafts.id, id), eq(drafts.userId, userId))`. The same rule applies to `mention_cache` (`ownerId`) and the ledger. The internal publisher helpers (`persistTweetId`, `markPublished`, `markFailed`) update by draft id only, after a scoped claim. Don't expose them to user input directly.
6. **CSRF:**
   - Every mutating route (POST/PATCH/DELETE) calls `assertSameOrigin(req)` first. Routes with a body also call `assertJson(req)`, which returns 415 otherwise.
   - The credit-spending **GET** `/api/mentions/search` calls `assertSameSiteFetch(req)` (`Sec-Fetch-Site: same-origin`, or a Referer fallback), because SameSite=Lax cookies ride along on top-level cross-site navigations.
   - Logout is POST-only.
   - Any new paid GET needs `assertSameSiteFetch`.
7. **Errors reach clients only through `errorResponse(e)` / `toPublicError(e)`.**
   - Responses look like `{ error, code, ...extra }`.
   - Unknown errors become `500 internal_error` and are logged server-side only. DB errors can embed SQL and encrypted-token params; X bodies can carry anything.
   - `drafts.last_error` is always `publicErrorText(e)`, in the form `[code] message`.
   - When logging, prefer `e.name` or the status over the whole error object, and never log tokens, codes or verifiers.
   - `HttpError` gets code `"error"` unless you pass `extra.code`, as in `{ code: "post_too_long", … }`.
8. **Tokens are encrypted with AAD = userId** (`v2:`). Always pass the owning userId to `encrypt`/`decrypt`, so a ciphertext copied onto another row fails. Never store or log plaintext tokens. Changing `TOKEN_ENCRYPTION_KEY` invalidates every stored token.
9. **Sessions are revocable.** `getSession` checks the JWT `ver` against `users.session_version`. `revokeSessions` (called on logout) bumps it. The middleware only verifies the signature, so **API routes must call `requireUserId()`/`getSession()`**: never trust the middleware alone, and note that it skips `/api/**`.
10. **Token refresh uses a DB claim** (`refreshWithDbClaim` in `x/index.ts`).
    - It refreshes when the token expires within 2 minutes.
    - Within one process, concurrent callers share a single in-flight promise. Across instances, the one that atomically sets `x_tokens.refreshing_until` (30s claim) is the only one that calls X; the rest poll.
    - Rotated tokens are persisted with retries, because the old refresh token is dead.
    - Late writes are compare-and-set on the refresh token that was read.
    - `invalid_grant` sets `needs_reconnect` and throws `ReconnectRequiredError` (409).
    - Don't add a second refresh path.
11. **Mock mode can't run on production.** `env.mockX` returns false when `VERCEL_ENV=production`. Mock login additionally needs `NODE_ENV !== "production"` or `ALLOW_MOCK_LOGIN=1`. Keep both guards: mock login is a full auth bypass.
12. **CSP lives in `next.config.ts`.** It allows images from `pbs.twimg.com`, `abs.twimg.com` and `unavatar.io`, and `form-action` to `x.com`. `connect-src` is `'self'`. Update it whenever you add an external host (images, fetches, fonts) or the page breaks in prod. Don't loosen `frame-ancestors`, and don't add `unsafe-eval` for production.
13. **Rate limits:** login and callback are limited per IP via `clientIp`; search, publish, draftCreate and admin are limited per user. Add `limitNamed` to any new costly or abusable route.
14. **Admin endpoints** use `requireAdmin(db)`, which returns **404** to non-admins so the surface stays hidden.
15. **x402 purchases** (`POST /api/credits/purchase`):
    - Never credit before the facilitator reports a successful settlement on the expected network with a tx hash.
    - Build requirements server-side from the pack id; never trust client amount, `payTo`, asset or network.
    - `UNIQUE(network, payer, nonce)` and `UNIQUE(tx_hash)` prevent replays and double credits.
    - The 402 challenge is a documented exception to `errorResponse`. The client calls it with raw `fetch`, because `apiFetch` treats every 402 as insufficient credits.
    - Wallet code (viem, `@x402/*`) must stay in lazy chunks (`next/dynamic` / dynamic `import()`), so users who never pay download none of it.
16. **Never commit secrets or `.env*` files.** Only `.env.example` is tracked, and it must hold no real values. Never put real tokens, X ids of real users, or the instance URL in code, tests or docs.

## 8. Recipes

### Add an API route

Copy the pattern from `src/app/api/drafts/route.ts`:

```ts
// src/app/api/widgets/[id]/route.ts
import { getDb } from "@/lib/db";
import { requireUserId } from "@/lib/session";
import { errorResponse, HttpError } from "@/lib/errors";
import { assertJson, assertSameOrigin } from "@/lib/http";
import { limitNamed } from "@/lib/ratelimit";
import { z } from "zod";

export const dynamic = "force-dynamic";
const Body = z.object({ name: z.string().trim().min(1).max(100) });
type Ctx = { params: Promise<{ id: string }> };    // Next 15: params is a Promise

export async function POST(req: Request, { params }: Ctx) {
  try {
    assertSameOrigin(req);                 // 1. CSRF (all mutating methods)
    assertJson(req);                       // 2. only if it has a body
    const userId = await requireUserId();  // 3. session (+ session_version) → 401
    const db = await getDb();
    await limitNamed(db, "draftCreate", userId); // 4. rate limit (add a LIMITS entry if new)
    const { id } = await params;
    const input = Body.parse(await req.json());  // 5. zod → 400 invalid_request
    // 6. call a src/lib function; scope every query by userId; X calls via getMeteredXClient
    if (!id) throw new HttpError(404, "Not found");
    return Response.json({ ok: true, input });
  } catch (e) {
    return errorResponse(e);               // 7. never return raw errors
  }
}
```

- Keep handlers thin and put logic in `src/lib/*` so it can be tested.
- Paid GETs use `assertSameSiteFetch(req)` instead of the origin and JSON checks.
- Add a client wrapper in `src/components/lib/api.ts` and update `docs/ARCHITECTURE.md`.

### Add an X API call

1. Add the method to the `XClient` interface in `src/lib/x/types.ts`.
2. Implement it in `x/real.ts`, throwing `XApiError(status, body)` on non-2xx, and in `x/mock.ts`, so mock mode and tests keep working.
3. Meter it in `meter()` (`x/metered.ts`). Decide its cost, debit before the call, and choose the refund rule:
   - Reads: reserve, then refund the unused part.
   - Writes: refund only on a definite rejection, and throw `AmbiguousPublishError` otherwise.
   - Only free endpoints may pass straight through, like `me`.
4. Update every `FakeX` class in the tests, since they implement `XClient`.
5. Add a `metered.test.ts` case for both the charge and the refund.
6. If the call needs a new OAuth scope, add it to `X_SCOPES` in `x/index.ts`. Existing users must log in again.

### Add a credit cost

1. Add a getter to `CREDIT_COSTS` in `src/lib/credits.ts` using `intEnv("CREDIT_COST_<NAME>", default)`.
2. Document the env override in `.env.example`, the README table and ARCHITECTURE.md.
3. Use it inside `meter()`, not in routes. If it affects publish estimates, update `postCost`/`estimateThreadCost` too.
4. Expose it in `GET /api/credits` `costs` and the `CreditCosts` type if the UI should show it.
5. `CREDIT_COSTS.ownedRead` (default 1) already exists but is currently unused.

## 9. UI conventions

- **Styling:** the X-like tokens in `src/app/globals.css` are CSS variables mapped through Tailwind v4 `@theme inline`. Use `bg-canvas`, `text-ink`, `text-muted`, `text-faint`, `border-line`, `border-line-strong`, `bg-accent` / `hover:bg-accent-hover`, `bg-accent-soft`, `bg-hover`, `bg-card`, `bg-sidebar`, `text-danger`, `bg-warn`, `text-success`, `bg-overlay` and `shadow-pop`.
  - Dark mode comes from `prefers-color-scheme` only; there is no toggle.
  - **Don't hardcode colors**; add a token in both themes instead.
  - Fonts: `font-sans`, and `font-tweet` for post text.
- **Components** (`src/components/`): `app/` (AppProvider, AppShell), `composer/`, `sidebar/`, `credits/` (CreditsChip, LedgerList), `admin/`, `ui/` (Avatar, Modal, Spinner, VerifiedBadge, `icons.tsx` with inline SVG icons) and `lib/` (`api.ts`, `time.ts`). Most are client components (`"use client"`).
- **Client API layer:** `src/components/lib/api.ts`.
  - **Always go through `api.*` / `apiFetch`**, never a bare `fetch`. The only exception is logout.
  - `apiFetch` sets JSON headers and `credentials`. It redirects to `/login` on a 401 and throws `ApiError(status, message, code, extra)`.
  - Error `code`s include `insufficient_credits` (`needed`, `balance`), `rate_limited` (`retryAfter`), `credit_cap_reached`, `reconnect_required`, `publish_uncertain`, `x_api_error`, `post_too_long` (`index`, `weighted`, `max`), `draft_limit`, `invalid_request` (`issues`), `invalid_json`, `unauthorized`, `internal_error` and the generic `error`.
  - `creditErrorMessage(e)` maps credit, rate-limit, cap and reconnect errors to toast text.
  - Client types are duplicated here (`Draft`, `Me`, …), so keep them in sync with the server serializers.
- **AppProvider** (`useApp()`) holds the global state:
  - `me`, `credits`, the `drafts` list, `tab` (draft/scheduled/published/failed; `publishing` shows under scheduled) and `sidebarOpen`.
  - Actions: `toast()`, `refreshMe()` (refetches `/api/me` and `/api/credits`, and also runs on tab visibility), `refreshDrafts()`, `upsertDraft()` and `removeDraft()`.
  - Call `refreshMe()` after anything that changes the balance.
- **AppShell:** the **Composer is mounted in the `(app)` layout**, not the page, so it survives the `/` → `/drafts/:id` URL change after the first autosave. On `/admin` it stays mounted but hidden.
  - Autosave is debounced (800 ms) in `Composer.tsx`.
  - The ReconnectBanner shows when `me.needsReconnect` is set.
- **Composer highlighting (mirrored overlay)** in `PostEditor.tsx`:
  - The textarea (`.tweet-text.composer-input`) has **transparent text** with a visible caret. It is stacked in the same CSS grid cell over an `aria-hidden` mirror `<div>`, which renders the same text through `renderMirror()` using `tokenize()` (entities in `text-accent`) and `overflowIndex()` (overflow on `bg-danger/25`).
  - Both layers share the `.tweet-text` metrics: font, size, line-height, `pre-wrap` and wrapping. **Any change to padding, font or wrapping must apply to both layers, or the caret drifts.**
  - A zero-width trailing character keeps the heights equal.
- **Mention autocomplete:**
  - `findMention()` detects `@handle` before the caret. A marker span in the mirror positions `MentionMenu`.
  - `useMentionSearch` is debounced (200 ms) and abortable. It keeps a per-query in-memory cache and narrows locally on each keystroke. Degraded `creditsExhausted` results are not cached.
  - The textarea uses combobox ARIA attributes.
  - The server side merges `mention_cache` with metered X search. It calls X only when `q.length >= 2` and there are fewer than 5 cache hits. It keeps a 60-second per-process memo (memo hits are free) and falls back to exact lookup.
- Keyboard shortcuts:
  - <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> adds a post below. Type three newlines to split the current post at the caret.
  - <kbd>Alt/Option</kbd>+<kbd>↑</kbd> or <kbd>↓</kbd> moves the active post.
  - <kbd>Backspace</kbd> in an empty post removes it.

## 10. Deployment (Vercel)

- **Database:** use Neon from the Vercel Marketplace; it sets `DATABASE_URL`. Migrations run in `pnpm build`.
- **Env vars:**
  - **Required:** `APP_URL` (prod URL, no trailing slash), `X_CLIENT_ID`, `X_CLIENT_SECRET`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `CRON_SECRET` and `DATABASE_URL`.
  - **Credits:** `ADMIN_X_USER_IDS`, `SIGNUP_CREDITS`, `GLOBAL_DAILY_CREDIT_CAP` and `ALLOWED_X_USER_IDS`.
  - **Optional:** `CREDIT_COST_POST`, `CREDIT_COST_POST_WITH_URL` and `CREDIT_COST_USER_READ`.
  - **Never set** `MOCK_X` or `ALLOW_MOCK_LOGIN` on Production.
- **Preview deployments** run in mock mode, so PRs can be tested without real X OAuth or real posts (the preview URL's callback isn't registered on the X app):
  - Scope Preview variables to Preview, ideally to the PR's git branch. Don't edit or re-scope Production variables.
  - Set `MOCK_X=1` and `ALLOW_MOCK_LOGIN=1`, with fresh `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` and `CRON_SECRET` values (never reuse prod's), and `APP_URL` set to the exact preview URL the browser uses (no trailing slash).
  - **Preview must use a non-production `DATABASE_URL`.** Every build runs the migrations against `DATABASE_URL`, and mock login is a full auth bypass.
    - When the Neon integration connects, it scopes its `DATABASE_URL` and `PG*`/`POSTGRES_*` vars to Production, Preview *and* Development. Left that way, every preview build migrates the prod DB.
    - Take Preview off those integration vars, and give Preview its own `DATABASE_URL` that points at a separate database (or a Neon branch). Re-check this if the integration is ever reconnected.
    - A preview-built migration lands before the PR merges, so test schema changes on the preview DB, never on prod.
    - Before you add the mock flags, check the pulled value: `vercel env pull --environment=preview --git-branch=<branch>`.
  - Keep Vercel deployment protection on for previews. With mock login, anyone who reaches the preview can sign in.
  - The guards in invariant 11 still apply: `mockX` is off whenever `VERCEL_ENV=production`.
- **Cron:** `vercel.json` runs `* * * * *` on `/api/cron/publish`.
  - Every-minute cron requires the **Pro plan**. On Hobby, use an external pinger that sends `Authorization: Bearer $CRON_SECRET`.
  - The handler accepts GET or POST and processes up to 10 drafts per run (`maxDuration` 60).
  - If `CRON_SECRET` is unset, the endpoint always returns 401.
- **X developer app** (console.x.com, under User authentication settings):
  - Permissions: **Read and write**.
  - Type: **Web App (confidential client)**.
  - Callback URI: **`$APP_URL/api/auth/callback`**, plus `http://localhost:3000/api/auth/callback` for local tests.
  - Scopes requested (`X_SCOPES`): `tweet.read tweet.write users.read offline.access`. `offline.access` is required for refresh tokens.
- **Credit and access env vars:**
  - `ADMIN_X_USER_IDS`: comma-separated **numeric** X user ids (shown in the account menu). Admins get unlimited, logged credits and `/admin`, and are always allowed to sign in.
  - `SIGNUP_CREDITS` (default 1000): granted once on first sign-in, and backfilled for users created before credits existed. Set it to `0` to require admin grants.
  - `GLOBAL_DAILY_CREDIT_CAP` (default 20000 ≈ $20/day): the rolling 24h limit on non-admin spend; `0` disables it.
  - `ALLOWED_X_USER_IDS` (optional): a sign-in allowlist, checked before the user row is created. Empty means anyone can sign in.

## 11. Git conventions

- **Commits:**
  - **Commit only when the user asks.** Branch first if you're on `main`.
  - Use short imperative subjects, with an optional bulleted body.
  - Agent-authored commits end with a `Co-Authored-By:` trailer naming the model (see `git log`). Use the attribution line your harness provides.
- **Public repo** (`github.com/mykcryptodev/mykfully`). Before staging, check `git status` and `git diff --cached` for:
  - secrets, `.env*`, `./.data`, `.next`, tsbuildinfo;
  - absolute local paths, personal info, real X ids or handles.

  Never force-push `main` or rewrite published history.
- Keep `README.md` and `docs/ARCHITECTURE.md` in step with behavior changes.

## 12. Known limitations and TODOs

- **Media uploads are mock-tested only.** Files are stored as 2 MB `bytea` chunks in Postgres (`media_assets`/`media_chunks`, 128 MB and 256 files per user, unreferenced uploads pruned after 24h) and uploaded to X just before each post. Existing users must re-login to grant `media.write`; until then publishing a post with media fails with `reconnect_required`.
- **The CSP uses `'unsafe-inline'`** for `script-src` and `style-src` (needed by Next and Tailwind). Nonce-based CSP is a TODO. Dev also adds `'unsafe-eval'`.
- **Real X OAuth, posting and Neon are untested.** Only mock mode and PGlite were exercised end to end, so be cautious with `real.ts` and neon-specific behavior.
- **Rate limits are fixed-window** in Postgres. Old windows are cleaned up opportunistically (1% of calls).
- **The mention-search memo is per process,** so it isn't shared across serverless instances.
- **`publish_uncertain` needs manual action.** The user checks X, then reschedules.
- **The draft list is capped at 200** per status query, and each user can have at most 500 drafts.
- **A failed `getDb()` init sticks.** The promise is cached, so restart the server after fixing the DB. If PGlite reports `relation … already exists`, the dir is probably half-migrated or left over. Delete that local dir; it holds local data only.

### Doc drift (the code is authoritative)

- ARCHITECTURE.md says long posts are for `blue` only. `text.ts` allows `premium` and `blue`.
- ARCHITECTURE.md shows a plain claim `UPDATE`. The real claim uses a `FOR UPDATE SKIP LOCKED` subselect and also reclaims stale rows.
- `unauthorized()` in `session.ts` and the cron 401 return `{ error: "unauthorized" }` without going through `errorResponse`.
