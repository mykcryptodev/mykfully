import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import { env } from "../env";
import { decrypt, encrypt } from "../crypto";
import { createRealXClient } from "./real";
import { MOCK_ME, createMockXClient } from "./mock";
import type { XClient, XTokenSet, XUser } from "./types";

export * from "./types";

export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
export const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
export const X_SCOPES = "tweet.read tweet.write users.read offline.access media.write";
const REFRESH_SKEW_MS = 2 * 60 * 1000;

export function redirectUri(): string {
  return `${env.appUrl}/api/auth/callback`;
}

type TokenResponse = {
  token_type: string;
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

export class XTokenError extends Error {
  constructor(public status: number, public body: string) {
    super(`X token endpoint ${status}: ${body.slice(0, 300)}`);
  }
}

/** POST to the X token endpoint. Confidential clients use Basic auth (client_id omitted from body). */
async function tokenRequest(params: Record<string, string>): Promise<XTokenSet> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  const secret = env.xClientSecret;
  if (secret) {
    headers.Authorization = `Basic ${Buffer.from(`${env.xClientId}:${secret}`).toString("base64")}`;
  } else {
    body.set("client_id", env.xClientId);
  }
  const res = await fetch(X_TOKEN_URL, { method: "POST", headers, body, cache: "no-store" });
  const text = await res.text();
  if (!res.ok) throw new XTokenError(res.status, text);
  const t = JSON.parse(text) as TokenResponse;
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (t.expires_in ?? 7200) * 1000),
    scope: t.scope ?? null,
  };
}

export function exchangeAuthCode(code: string, codeVerifier: string): Promise<XTokenSet> {
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: codeVerifier,
  });
}

/** Insert/update the users row. Never overwrites the user's timezone. */
export async function upsertUser(u: XUser): Promise<void> {
  const db = await getDb();
  const now = new Date();
  await db
    .insert(schema.users)
    .values({
      id: u.id,
      username: u.username,
      name: u.name,
      profileImageUrl: u.profileImageUrl ?? null,
      verifiedType: u.verifiedType ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.users.id,
      set: {
        username: u.username,
        name: u.name,
        profileImageUrl: u.profileImageUrl ?? null,
        verifiedType: u.verifiedType ?? null,
        updatedAt: now,
      },
    });
}

/** Store (encrypted) tokens for a user, replacing any existing set. */
export async function saveTokens(userId: string, t: XTokenSet): Promise<void> {
  const db = await getDb();
  const row = {
    accessTokenEnc: encrypt(t.accessToken),
    refreshTokenEnc: t.refreshToken ? encrypt(t.refreshToken) : null,
    expiresAt: t.expiresAt,
    scope: t.scope ?? null,
    updatedAt: new Date(), // explicit ms-precision value; used as the optimistic-lock version
  };
  await db
    .insert(schema.xTokens)
    .values({ userId, ...row })
    .onConflictDoUpdate({ target: schema.xTokens.userId, set: row });
}

type TokenRow = typeof schema.xTokens.$inferSelect;

async function readTokenRow(userId: string): Promise<TokenRow | null> {
  const db = await getDb();
  const rows = await db.select().from(schema.xTokens).where(eq(schema.xTokens.userId, userId)).limit(1);
  return rows[0] ?? null;
}

function rowToTokens(r: TokenRow): XTokenSet {
  return {
    accessToken: decrypt(r.accessTokenEnc),
    refreshToken: r.refreshTokenEnc ? decrypt(r.refreshTokenEnc) : null,
    expiresAt: r.expiresAt,
    scope: r.scope,
  };
}

const needsRefresh = (r: TokenRow) => r.expiresAt.getTime() < Date.now() + REFRESH_SKEW_MS;

async function doRefresh(userId: string, opts: { force?: boolean }): Promise<XTokenSet> {
  const row = await readTokenRow(userId);
  if (!row) throw new Error(`No X tokens stored for user ${userId}; please sign in again`);
  if (!opts.force && !needsRefresh(row)) return rowToTokens(row);
  const current = rowToTokens(row);
  if (!current.refreshToken) return current; // nothing we can do; let the API call surface 401

  const oldVersion = row.updatedAt;
  let fresh: XTokenSet;
  try {
    fresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: current.refreshToken });
  } catch (err) {
    // Another process may have rotated the (single-use) refresh token first. Use its result if so.
    const latest = await readTokenRow(userId);
    if (latest && latest.updatedAt.getTime() !== oldVersion.getTime() && !needsRefresh(latest)) {
      return rowToTokens(latest);
    }
    throw err;
  }

  const db = await getDb();
  const updated = await db
    .update(schema.xTokens)
    .set({
      accessTokenEnc: encrypt(fresh.accessToken),
      // X rotates refresh tokens; keep the old one only if (unexpectedly) none was returned.
      refreshTokenEnc: encrypt(fresh.refreshToken ?? current.refreshToken),
      expiresAt: fresh.expiresAt,
      scope: fresh.scope ?? row.scope,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.xTokens.userId, userId),
        // compare at ms precision (JS Date) to avoid microsecond mismatches
        sql`date_trunc('milliseconds', ${schema.xTokens.updatedAt}) = ${oldVersion.toISOString()}::timestamptz`,
      ),
    )
    .returning({ userId: schema.xTokens.userId });

  if (updated.length === 0) {
    // Lost the race: someone else persisted a newer token set. Prefer what's in the DB.
    const latest = await readTokenRow(userId);
    if (latest) return rowToTokens(latest);
  }
  return { ...fresh, refreshToken: fresh.refreshToken ?? current.refreshToken };
}

const g = globalThis as unknown as { __mykRefresh?: Map<string, Promise<XTokenSet>> };
const inflight = (g.__mykRefresh ??= new Map());

/**
 * Returns a valid token set for the user, refreshing if it expires within 2 minutes.
 * Concurrent callers in this process share one refresh; cross-process races are resolved
 * via an optimistic `updated_at` check.
 */
export function refreshIfNeeded(userId: string, opts: { force?: boolean } = {}): Promise<XTokenSet> {
  const existing = inflight.get(userId);
  if (existing) return existing;
  const p = doRefresh(userId, opts).finally(() => inflight.delete(userId));
  inflight.set(userId, p);
  return p;
}

export async function getXClientForUser(userId: string): Promise<XClient> {
  if (env.mockX) return createMockXClient();
  const tokens = await refreshIfNeeded(userId);
  return createRealXClient(tokens.accessToken);
}

/** Mock mode: upsert the demo user and return its id (no OAuth, no tokens). */
export async function mockLogin(): Promise<string> {
  await upsertUser(MOCK_ME);
  return MOCK_ME.id;
}
