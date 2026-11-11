import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import { users } from "./db/schema";
import { env } from "./env";

const MAX_AGE_SECONDS = 60 * 60 * 24 * 14; // 14 days

/**
 * `__Host-` in production: Secure, Path=/, no Domain — can't be set by a subdomain or over http.
 * Keep in sync with src/middleware.ts (which can't import this module: it pulls in the DB).
 */
export function sessionCookieName(): string {
  return env.isProd ? "__Host-myk_session" : "myk_session";
}

/** Short-lived PKCE/state cookie, scoped to /api/auth. */
export function oauthCookieName(): string {
  return env.isProd ? "__Secure-myk_oauth" : "myk_oauth";
}
export const OAUTH_COOKIE_PATH = "/api/auth";

export class UnauthorizedError extends Error {
  constructor(msg = "Unauthorized") {
    super(msg);
    this.name = "UnauthorizedError";
  }
}

/** Standard 401 JSON response for route handlers. */
export function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

function secretKey(): Uint8Array {
  return new TextEncoder().encode(env.sessionSecret);
}

export async function signSessionToken(userId: string, ver: number): Promise<string> {
  return new SignJWT({ ver })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secretKey());
}

/** Signature + expiry only (no DB). Tokens without an integer `ver` claim are rejected. */
export async function verifySessionToken(token: string): Promise<{ userId: string; ver: number } | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    const ver = payload.ver;
    if (!payload.sub || typeof ver !== "number" || !Number.isInteger(ver)) return null;
    return { userId: payload.sub, ver };
  } catch {
    return null;
  }
}

/** Valid JWT AND the user still exists AND its session_version matches (logout/revocation bumps it). */
export async function getSession(): Promise<{ userId: string } | null> {
  const token = (await cookies()).get(sessionCookieName())?.value;
  if (!token) return null;
  const claims = await verifySessionToken(token);
  if (!claims) return null;
  const db = await getDb();
  const [row] = await db
    .select({ ver: users.sessionVersion })
    .from(users)
    .where(eq(users.id, claims.userId))
    .limit(1);
  if (!row || row.ver !== claims.ver) return null;
  return { userId: claims.userId };
}

export async function requireUserId(): Promise<string> {
  const s = await getSession();
  if (!s) throw new UnauthorizedError();
  return s.userId;
}

function cookieOpts(maxAge: number) {
  return { httpOnly: true, secure: env.isProd, sameSite: "lax" as const, path: "/", maxAge };
}

/** Issue a session bound to the user's current session_version. The user row must exist. */
export async function setSession(userId: string): Promise<void> {
  const db = await getDb();
  const [row] = await db.select({ ver: users.sessionVersion }).from(users).where(eq(users.id, userId)).limit(1);
  if (!row) throw new Error("Cannot create a session for an unknown user");
  const token = await signSessionToken(userId, row.ver);
  (await cookies()).set(sessionCookieName(), token, cookieOpts(MAX_AGE_SECONDS));
}

export async function clearSession(): Promise<void> {
  (await cookies()).set(sessionCookieName(), "", cookieOpts(0));
}

/** Invalidate every outstanding session for the user. */
export async function revokeSessions(userId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(users)
    .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
    .where(eq(users.id, userId));
}
