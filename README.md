# mykfully

An open-source, self-hostable take on [Typefully](https://typefully.com): write X (Twitter) threads in an editor that looks like X, @mention people with live search, and schedule posts to go out automatically.

Built with Next.js 15 (App Router), Drizzle ORM + Postgres (Neon), and Tailwind. Designed to deploy on Vercel.

## Features

- **Log in with X.** Uses OAuth 2.0 with PKCE. Tokens are encrypted at rest (AES-256-GCM) and refreshed automatically, so scheduled posts keep working while you're away.
- **Thread composer that looks like X:**
  - Avatar, name and handle on every post, with the thread connector line.
  - Live highlighting of @mentions, #hashtags and links.
  - The real X character counter (`twitter-text` weighted length: links count as 23, emoji as 2).
  - Long-post limits for Premium accounts.
  - Split long text into a thread.
- **Keyboard shortcuts:**
  - <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> adds a post below. Type three newlines to split the current post at the caret.
  - <kbd>Alt/Option</kbd>+<kbd>↑</kbd> or <kbd>↓</kbd> moves the active post.
  - <kbd>Backspace</kbd> in an empty post removes it.
  - <kbd>⌘/Ctrl</kbd>+<kbd>K</kbd> opens the command bar.
  - <kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> toggles focus mode, and <kbd>Esc</kbd> exits it. <kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> switches between desktop and mobile editor widths.
  - <kbd>⌘/Ctrl</kbd>+<kbd>.</kbd> starts a draft, <kbd>⌘/Ctrl</kbd>+<kbd>/</kbd> toggles the sidebar, and <kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> opens publish confirmation.
  - <kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>.</kbd> opens the emoji picker. Type `:` and an alias to search inline.
- **@mention autocomplete.** Searches X users as you type. It falls back to exact-handle lookup, plus a local cache of people you've mentioned before, when user search isn't available on your API plan.
- **X-style preview** with desktop and mobile layouts.
- **Autosaved drafts**, with Drafts, Scheduled, Published and Failed views.
- **Scheduling** in your timezone, plus **Publish now**:
  - Pick a date and time on the calendar, or enter a time such as “tomorrow at 9am” or “in 3 hours.”
  - A Vercel Cron job runs every minute and publishes due threads.
  - It claims each thread atomically, so a thread can't be posted twice.
  - It saves each tweet ID as it goes, so a thread that fails midway resumes where it stopped instead of reposting.
  - It retries up to 3 times. If X may have published a post anyway (timeout, network error, X 5xx), the thread is marked failed instead of retried, so nothing is posted twice. Check X, then reschedule.

## Credits (protecting your X API bill)

Every user spends **credits** whenever mykfully calls a paid X API endpoint on their behalf. 1 credit ≈ $0.001.

| Action | Credits |
|---|---|
| Publish a post | 15 |
| Publish a post that contains a link | 200 |
| @mention search (per user returned, max 8) | 10 |

- **Balances:**
  - New accounts get `SIGNUP_CREDITS` once (default 1000, about $1). Set it to `0` so new accounts have nothing until you grant credits.
  - When a user runs out, publishing and paid searches stop. Cached mention suggestions keep working.
- **Admins:**
  - Admins are listed in `ADMIN_X_USER_IDS` (your numeric X user id, shown in the account menu).
  - Admins have **unlimited** credits; their spend is still logged.
  - Admins use the **/admin** page to see every user's balance and spending and to grant or revoke credits.
- **Safety limits:**
  - `GLOBAL_DAILY_CREDIT_CAP` caps total non-admin spend per rolling 24 hours across the whole instance. It defaults to 20000 (about $20/day); set it to `0` to disable the cap.
  - `ALLOWED_X_USER_IDS` (optional, comma-separated X user ids) restricts who can sign in. Admins are always allowed. When unset, anyone with an X account can sign in.
  - Per-user rate limits apply to search, publishing, draft creation and login.
- **Ledger:** every charge, refund, grant and purchase is recorded in an append-only ledger.
- **Buying credits (optional):** an instance can let users top up with USDC; see [below](#optional-sell-credits-for-usdc-via-x402).

## Optional: sell credits for USDC via x402

X's API doesn't accept [x402](https://x402.org) payments, so this doesn't change how posts are paid for. Instead, an instance can **sell its own credits**: users top up their balance by paying USDC on Base from a browser wallet. It is **off by default** and adds nothing to the page for instances (or users) that never use it: the wallet code is only downloaded when someone presses "Pay with wallet".

| Pack | Price | Credits |
|---|---|---|
| `p1` | $1 USDC | 1,000 |
| `p5` | $5 USDC | 5,000 |
| `p20` | $20 USDC | 20,000 |

**How it works:** the user picks a pack and signs a USDC transfer authorization (EIP-3009) in their wallet: no gas, no approval transaction. The server checks it against the price it set itself, has an x402 *facilitator* verify and settle it on-chain, and only then adds the credits. Each purchase is recorded in `credit_purchases` and as a `purchase` row in the ledger (with the transaction hash).

**Env vars** (the feature is on only when all the required ones are valid):

| Variable | Meaning |
|---|---|
| `PAY_TO_ADDRESS` | The address that receives the USDC. A mistyped (bad-checksum) address disables the feature. |
| `X402_NETWORK` | `base-sepolia` (testnet) or `base` (mainnet). |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | Required for `base` only: a [Coinbase Developer Platform](https://portal.cdp.coinbase.com) API key for the CDP facilitator. Without them, mainnet purchases stay off. |
| `X402_RPC_URL` | Optional. RPC endpoint for the reconcile script (defaults to the chain's public RPC). |

**Try it on testnet first:**

1. Set `PAY_TO_ADDRESS=<an address you control>` and `X402_NETWORK=base-sepolia`. Testnet uses the free `https://x402.org/facilitator`, so no keys are needed.
2. In your wallet (Coinbase Wallet, MetaMask, Rabby…), get Base Sepolia USDC from the [Circle faucet](https://faucet.circle.com). You don't need ETH: the facilitator pays the gas.
3. Open the credits chip in the sidebar, choose **Buy credits**, pick a pack and confirm the signature request. The app asks the wallet to switch to Base Sepolia.

**Going to mainnet:** set `X402_NETWORK=base` and the two CDP keys. Real USDC then moves to `PAY_TO_ADDRESS`. Check Coinbase's facilitator terms and pricing, and your own tax and legal obligations, before selling anything.

**Things to know:**

- **Refunds are manual.** Purchases are final in the app. To refund someone, send the USDC back from your wallet and revoke the credits on `/admin`.
- **Unconfirmed payments.** If the server can't tell whether a payment settled (a facilitator timeout, for example), the user sees "submitted, don't pay again" and **no credits are added yet**. Run the reconcile script to resolve these. It checks the chain, credits purchases whose USDC transfer really happened, and marks expired ones as failed:

  ```bash
  DATABASE_URL=... X402_NETWORK=base pnpm purchases:reconcile            # add --dry-run to only report
  pnpm purchases:reconcile --include-failed                              # also re-check failed purchases
  pnpm purchases:reconcile --id <purchaseId> --tx <0xhash>               # check one purchase against a known transaction
  ```

  It is manual in v1 (not run by cron) and safe to run repeatedly. The public Base RPC is rate-limited and only serves small log ranges, so on mainnet set `X402_RPC_URL` to an endpoint from an RPC provider. A used authorization whose transaction can't be found, or doesn't pay you the exact amount, is reported as `needs_review` and never credited automatically.
- **The daily cap is about spending, not buying.** `GLOBAL_DAILY_CREDIT_CAP` still limits how many credits all non-admins can *spend* per 24 hours, including purchased ones. Raise it (or set `0`) if paying users hit it.
- **Wallets:** only injected browser wallets are supported (no WalletConnect), and only USDC on Base.
- **Not yet tested with real funds.** The flow is covered by automated tests with a stub facilitator and was checked against the testnet facilitator up to verification; do a testnet purchase yourself before enabling mainnet.

## Quick start (local, no X account needed)

```bash
pnpm install
cp .env.example .env.local
# fill SESSION_SECRET, TOKEN_ENCRYPTION_KEY, CRON_SECRET (see comments), and set MOCK_X=1
pnpm dev
```

Open http://localhost:3000 and click **Continue with X**.

- With `MOCK_X=1` you're signed in as a demo user. Posting is simulated, and @mention search uses a built-in list of accounts.
- With `DATABASE_URL` empty, data is stored in an embedded Postgres (PGlite) in `./.data`.

Trigger the scheduler manually:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/publish
```

Run tests: `pnpm test`.

## Setting up the X app

1. Go to the [X Developer Console](https://console.x.com) and create a Project and App.
2. In **User authentication settings**, set:
   - **App permissions:** Read and write
   - **Type of App:** Web App (confidential client)
   - **Callback URI:** `https://<your-domain>/api/auth/callback` (and `http://localhost:3000/api/auth/callback` for local testing)
   - **Website URL:** your domain
3. Copy the **OAuth 2.0 Client ID and Client Secret** into `X_CLIENT_ID` and `X_CLIENT_SECRET`.
4. Scopes requested: `tweet.read tweet.write users.read offline.access media.write`.

> **API cost:** the X API is pay-per-use (credits).
> - Posting costs a small fee per post, and more for posts that contain links.
> - User search and lookups are billed per user returned. mykfully limits each search to 8 results, debounces keystrokes and caches results, to keep mention search cheap.

## Deploying to Vercel

1. Import this repo in Vercel.
2. Add a Postgres database. Neon from the Vercel Marketplace works and sets `DATABASE_URL`.
3. Set the env vars from `.env.example`:
   - `APP_URL`: your production URL
   - `X_CLIENT_ID` and `X_CLIENT_SECRET`
   - `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` and `CRON_SECRET`
   - `ADMIN_X_USER_IDS` and `SIGNUP_CREDITS`
   - Optionally `GLOBAL_DAILY_CREDIT_CAP` and `ALLOWED_X_USER_IDS`
   - Optionally the x402 variables, to [sell credits for USDC](#optional-sell-credits-for-usdc-via-x402)
   - Leave `MOCK_X` unset. It is ignored on production deployments anyway.
4. Deploy. Migrations run automatically before `next build` (`scripts/migrate.mjs`).
5. `vercel.json` registers a cron job that runs every minute on `/api/cron/publish`. Every-minute cron needs the Pro plan. On Hobby, point an external pinger (such as cron-job.org or a GitHub Action) at that URL with the `Authorization: Bearer $CRON_SECRET` header.

## Status / caveats

- **Tested with the mock client only.** The full flow (login, composing, @mention search, autosave, scheduling, the cron job publishing threads, resuming after a failure) was tested in `MOCK_X=1` mode against embedded Postgres (PGlite).
- **Not yet tested for real:**
  - X OAuth and posting to X, since no X API credentials were available while building it.
  - The Neon production database.
  
  Try it with a test X account first.
- **Anyone can log in unless you set `ALLOWED_X_USER_IDS`, and spending is capped.** Users can only spend their credit balance, and total non-admin spend is capped per day; see [Credits](#credits-protecting-your-x-api-bill).
- **No media uploads yet.** Image and video upload is not implemented, although the `media.write` scope is already requested.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Security

- **X tokens:** encrypted with AES-256-GCM, bound to the user id. Refresh is coordinated across serverless instances with a database claim. If X revokes access, the user is asked to reconnect.
- **Sessions:** signed with HS256 using a secret of at least 32 bytes, and stored in a `__Host-` cookie in production. Sessions can be revoked: logout invalidates every session for that account.
- **Request checks:** state-changing requests must come from your own `APP_URL` origin (CSRF protection). The credit-spending mention search also rejects cross-site requests (`Sec-Fetch-Site`, falling back to Referer).
- **Headers:** a strict Content-Security-Policy and other security headers are set.
- **Error messages:** errors shown to users are sanitized, so database details never leak.


This project uses pnpm with `minimumReleaseAge: 1440` (in `pnpm-workspace.yaml`), so a newly published dependency version can't be installed until it is at least 24 hours old.

## License

MIT
