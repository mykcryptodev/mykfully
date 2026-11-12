import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, schema, type DB } from "../db";
import { env } from "../env";
import { decrypt, encrypt } from "../crypto";
import { grantSignup } from "../credits";
import { ReconnectRequiredError } from "../errors";
import { XTokenError, createRealXClient, xTokenRequest } from "./real";
import { MOCK_ME, createMockXClient } from "./mock";
import type { XClient, XTokenSet, XUser } from "./types";

export * from "./types";
export { XTokenError, X_TOKEN_URL } from "./real";

export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
export const X_SCOPES = "tweet.read tweet.write users.read offline.access media.write";
const REFRESH_SKEW_MS = 2 * 60 * 1000;
/** Losers of the refresh claim re-read the row this often, for at most REFRESH_WAIT_MS. */
const REFRESH_POLL_MS = 500;
const REFRESH_WAIT_MS = 10_000;
const PERSIST_ATTEMPTS = 3;

export function redirectUri(): string {
  return `${env.appUrl}/api/auth/callback`;
}

function clientCreds() {
  return { clientId: env.xClientId, clientSecret: env.xClientSecret };
}

export function exchangeAuthCode(code: string, codeVerifier: string): Promise<XTokenSet> {
  return xTokenRequest(
    { grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: codeVerifier },
    clientCreds(),
  );
}

/**
 * Insert the users row if new (granting signup credits exactly once), otherwise refresh profile fields
 * (and backfill the signup grant for pre-credit users that never got one).
 * Never overwrites the user's timezone, credits or session_version.
 */
export async function upsertUser(u: XUser): Promise<{ created: boolean }> {
  const db = await getDb();
  const now = new Date();
  const profile = {
    username: u.username,
    name: u.name,
    profileImageUrl: u.profileImageUrl ?? null,
    verifiedType: u.verifiedType ?? null,
  };
  const inserted = await db
    .insert(schema.users)
    .values({ id: u.id, ...profile, createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: schema.users.id })
    .returning({ id: schema.users.id });

  if (inserted.length === 0) {
    await db
      .update(schema.users)
      .set({ ...profile, updatedAt: now })
      .where(eq(schema.users.id, u.id));
    await backfillSignupGrant(db, u.id);
    return { created: false };
  }

  try {
    await grantSignup(db, u.id);
  } catch (e) {
    // No retry: grant() isn't idempotent and may have committed. An admin can top up manually.
    console.error("[x] signup grant failed", e instanceof Error ? e.name : typeof e);
  }
  return { created: true };
}

/** Users created before the credit system have no 'signup' ledger row: grant it once, on their next login. */
async function backfillSignupGrant(db: DB, userId: string): Promise<void> {
  try {
    const [had] = await db
      .select({ id: schema.creditLedger.id })
      .from(schema.creditLedger)
      .where(and(eq(schema.creditLedger.userId, userId), eq(schema.creditLedger.kind, "signup")))
      .limit(1);
    if (!had) await grantSignup(db, userId);
  } catch (e) {
    console.error("[x] signup backfill failed", e instanceof Error ? e.name : typeof e);
  }
}

function encryptRow(userId: string, t: XTokenSet) {
  return {
    accessTokenEnc: encrypt(t.accessToken, userId),
    refreshTokenEnc: t.refreshToken ? encrypt(t.refreshToken, userId) : null,
    expiresAt: t.expiresAt,
    scope: t.scope ?? null,
    updatedAt: new Date(), // explicit ms-precision value; losers of the refresh claim watch it change
    refreshingUntil: null,
    needsReconnect: false,
  };
}

/** Store (encrypted) tokens for a user after login, replacing any existing set and clearing reconnect state. */
export async function saveTokens(userId: string, t: XTokenSet): Promise<void> {
  const db = await getDb();
  const row = encryptRow(userId, t);
  await db
    .insert(schema.xTokens)
    .values({ userId, ...row })
    .onConflictDoUpdate({ target: schema.xTokens.userId, set: row });
}

type TokenRow = typeof schema.xTokens.$inferSelect;

async function readTokenRow(db: DB, userId: string): Promise<TokenRow | null> {
  const rows = await db.select().from(schema.xTokens).where(eq(schema.xTokens.userId, userId)).limit(1);
  return rows[0] ?? null;
}

function rowToTokens(r: TokenRow): XTokenSet {
  return {
    accessToken: decrypt(r.accessTokenEnc, r.userId),
    refreshToken: r.refreshTokenEnc ? decrypt(r.refreshTokenEnc, r.userId) : null,
    expiresAt: r.expiresAt,
    scope: r.scope,
  };
}

const needsRefresh = (r: TokenRow) => r.expiresAt.getTime() < Date.now() + REFRESH_SKEW_MS;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noTokens = () => new Error("No X tokens stored for this user; please sign in again");

/** Cross-instance refresh lock: succeeds for exactly one caller until it clears or 30s pass. */
async function claimRefresh(db: DB, userId: string): Promise<TokenRow | null> {
  const rows = await db
    .update(schema.xTokens)
    .set({ refreshingUntil: sql`now() + interval '30 seconds'` })
    .where(
      and(
        eq(schema.xTokens.userId, userId),
        or(isNull(schema.xTokens.refreshingUntil), lt(schema.xTokens.refreshingUntil, sql`now()`)),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Compare-and-set guard on the refresh token we read: if another refresher already saved rotated tokens,
 * our late writes (claim release, needs_reconnect) must not touch their row.
 */
function sameRefreshToken(userId: string, readEnc: string | null) {
  return and(
    eq(schema.xTokens.userId, userId),
    readEnc === null ? isNull(schema.xTokens.refreshTokenEnc) : eq(schema.xTokens.refreshTokenEnc, readEnc),
  );
}

async function releaseClaim(db: DB, userId: string, readEnc: string | null): Promise<void> {
  await db.update(schema.xTokens).set({ refreshingUntil: null }).where(sameRefreshToken(userId, readEnc));
}

/** Persist rotated tokens (the old refresh token is now dead, so this must not be lost) and release the claim. */
async function persistRefreshed(db: DB, userId: string, t: XTokenSet): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.update(schema.xTokens).set(encryptRow(userId, t)).where(eq(schema.xTokens.userId, userId));
      return;
    } catch (e) {
      if (attempt >= PERSIST_ATTEMPTS) {
        console.error("[x/refresh] failed to persist rotated tokens", e instanceof Error ? e.name : e);
        throw new Error("Failed to save refreshed X tokens");
      }
      await sleep(100 * attempt);
    }
  }
}

/** We hold the claim on `row` (the fresh RETURNING row). Refresh, persist, release. */
async function refreshAsWinner(db: DB, row: TokenRow): Promise<XTokenSet> {
  const userId = row.userId;
  let released = false;
  try {
    const current = rowToTokens(row);
    if (!current.refreshToken) return current; // nothing we can do; let the API call surface 401

    let fresh: XTokenSet;
    try {
      fresh = await xTokenRequest({ grant_type: "refresh_token", refresh_token: current.refreshToken }, clientCreds());
    } catch (e) {
      if (e instanceof XTokenError && e.isDeadRefreshToken) {
        const flagged = await db
          .update(schema.xTokens)
          .set({ needsReconnect: true, refreshingUntil: null })
          .where(sameRefreshToken(userId, row.refreshTokenEnc))
          .returning({ userId: schema.xTokens.userId });
        released = true;
        if (flagged.length > 0) throw new ReconnectRequiredError();
        // Another refresher rotated the token while we waited (our claim had expired): use theirs.
        const latest = await readTokenRow(db, userId);
        if (latest && !latest.needsReconnect && !needsRefresh(latest)) return rowToTokens(latest);
        if (latest?.needsReconnect) throw new ReconnectRequiredError();
        throw new Error("X token refresh raced with another refresher; try again");
      }
      throw e;
    }

    const next: XTokenSet = {
      ...fresh,
      // X rotates refresh tokens; keep the old one only if (unexpectedly) none was returned.
      refreshToken: fresh.refreshToken ?? current.refreshToken,
      scope: fresh.scope ?? row.scope,
    };
    await persistRefreshed(db, userId, next); // also clears refreshing_until
    released = true;
    return next;
  } finally {
    if (!released) await releaseClaim(db, userId, row.refreshTokenEnc).catch(() => {});
  }
}

/**
 * DB-coordinated refresh (no in-process dedupe; see refreshIfNeeded). Exactly one caller across all instances
 * talks to the token endpoint; the rest poll until the rotated tokens land.
 * Exported for tests.
 */
export async function refreshWithDbClaim(userId: string, opts: { force?: boolean } = {}): Promise<XTokenSet> {
  const db = await getDb();
  const row = await readTokenRow(db, userId);
  if (!row) throw noTokens();
  if (row.needsReconnect) throw new ReconnectRequiredError();
  if (!opts.force && !needsRefresh(row)) return rowToTokens(row);

  const baseVersion = row.updatedAt.getTime();
  const deadline = Date.now() + REFRESH_WAIT_MS;

  while (Date.now() < deadline) {
    const claimed = await claimRefresh(db, userId);
    if (claimed) {
      if (claimed.needsReconnect) {
        await releaseClaim(db, userId, claimed.refreshTokenEnc);
        throw new ReconnectRequiredError();
      }
      // Someone else finished between our read and the claim: use their tokens.
      const changed = claimed.updatedAt.getTime() !== baseVersion;
      if ((changed || !opts.force) && !needsRefresh(claimed)) {
        await releaseClaim(db, userId, claimed.refreshTokenEnc);
        return rowToTokens(claimed);
      }
      return refreshAsWinner(db, claimed);
    }

    // Lost the claim: wait for the winner.
    while (Date.now() < deadline) {
      await sleep(REFRESH_POLL_MS);
      const latest = await readTokenRow(db, userId);
      if (!latest) throw noTokens();
      if (latest.needsReconnect) throw new ReconnectRequiredError();
      if (latest.updatedAt.getTime() !== baseVersion && !needsRefresh(latest)) return rowToTokens(latest);
      // Claim released (or expired) without fresh tokens — the winner failed. Try to claim ourselves.
      if (!latest.refreshingUntil || latest.refreshingUntil.getTime() < Date.now()) break;
    }
  }
  // Never hand back expired tokens: X would 401, which the publisher treats as fatal.
  throw new Error("Timed out waiting for X token refresh; try again");
}

const g = globalThis as unknown as { __mykRefresh?: Map<string, Promise<XTokenSet>> };
const inflight = (g.__mykRefresh ??= new Map());

/**
 * Returns a valid token set for the user, refreshing if it expires within 2 minutes.
 * Layer 1: concurrent callers in this process share one promise. Layer 2: a DB claim on
 * x_tokens.refreshing_until serializes refreshes across instances.
 * Throws ReconnectRequiredError if the user's X authorization is dead.
 *
 * `force`: if a refresh for this user is already in flight in this process, the caller joins it instead of
 * starting another one. That in-flight call may have been non-forced (and returned the still-valid tokens);
 * a caller that needs a guaranteed new token must call again once the returned promise settles.
 */
export function refreshIfNeeded(userId: string, opts: { force?: boolean } = {}): Promise<XTokenSet> {
  const existing = inflight.get(userId);
  if (existing) return existing;
  const p = refreshWithDbClaim(userId, opts).finally(() => inflight.delete(userId));
  inflight.set(userId, p);
  return p;
}

/** Un-metered X client for the user (mock client in MOCK_X mode). */
export async function getRawXClientForUser(userId: string): Promise<XClient> {
  if (env.mockX) return createMockXClient();
  const tokens = await refreshIfNeeded(userId);
  return createRealXClient(tokens.accessToken, tokens.scope);
}

/** @deprecated alias — call sites are moving to the metered wrapper (src/lib/x/metered.ts). */
export const getXClientForUser = getRawXClientForUser;

/** Mock mode: upsert the demo user (signup grant on first insert) and return its id (no OAuth, no tokens). */
export async function mockLogin(): Promise<string> {
  await upsertUser(MOCK_ME);
  return MOCK_ME.id;
}
