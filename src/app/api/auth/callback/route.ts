import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { RateLimitedError } from "@/lib/errors";
import { clientIp } from "@/lib/http";
import { limitNamed } from "@/lib/ratelimit";
import { OAUTH_COOKIE_PATH, oauthCookieName, setSession } from "@/lib/session";
import { XApiError, XTokenError, exchangeAuthCode, saveTokens, upsertUser } from "@/lib/x";
import { createRealXClient } from "@/lib/x/real";

export const dynamic = "force-dynamic";

function clearOauthCookie(res: NextResponse) {
  res.cookies.set(oauthCookieName(), "", {
    httpOnly: true,
    secure: env.isProd,
    sameSite: "lax",
    path: OAUTH_COOKIE_PATH,
    maxAge: 0,
  });
  return res;
}

/** Only whitelisted codes ever reach /login?error= (see src/app/login/page.tsx). */
function fail(code: "denied" | "login_failed" | "state_mismatch" | "not_allowed" | "rate_limited") {
  const url = new URL("/login", env.appUrl);
  url.searchParams.set("error", code);
  return clearOauthCookie(NextResponse.redirect(url));
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Log enough to debug without leaking tokens/codes (DB errors can embed encrypted-token params). */
function describe(err: unknown): string {
  if (err instanceof XTokenError) return err.message;
  if (err instanceof XApiError) return `XApiError ${err.status}`;
  return err instanceof Error ? err.name : typeof err;
}

/** ALLOWED_X_USER_IDS (if set) restricts sign-in; admins are always allowed. */
function isAllowedUser(xUserId: string): boolean {
  const allowed = env.allowedXUserIds;
  return !allowed || allowed.has(xUserId) || env.adminIds.has(xUserId);
}

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;

  try {
    await limitNamed(await getDb(), "callback", clientIp(req));
  } catch (e) {
    if (e instanceof RateLimitedError) return fail("rate_limited");
    console.error(`[auth/callback] rate limit check failed: ${describe(e)}`);
    return fail("login_failed");
  }

  // Validate state FIRST, so a forged ?error= (or code) from a third-party link is never honoured.
  let stored: { state?: unknown; verifier?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse(req.cookies.get(oauthCookieName())?.value ?? "{}");
    if (parsed && typeof parsed === "object") stored = parsed;
  } catch {
    /* fallthrough */
  }
  const state = p.get("state");
  if (
    typeof stored.state !== "string" ||
    typeof stored.verifier !== "string" ||
    !state ||
    !safeEqual(stored.state, state)
  ) {
    return fail("state_mismatch");
  }

  if (p.get("error")) return fail(p.get("error") === "access_denied" ? "denied" : "login_failed");

  const code = p.get("code");
  if (!code) return fail("login_failed");

  try {
    const tokens = await exchangeAuthCode(code, stored.verifier);
    const me = await createRealXClient(tokens.accessToken).me();
    if (!isAllowedUser(me.id)) {
      console.warn("[auth/callback] sign-in rejected: X user not in ALLOWED_X_USER_IDS");
      return fail("not_allowed");
    }
    await upsertUser(me);
    await saveTokens(me.id, tokens); // also clears needs_reconnect / refreshing_until
    await setSession(me.id);
  } catch (err) {
    console.error(`[auth/callback] login failed: ${describe(err)}`);
    return fail("login_failed");
  }

  return clearOauthCookie(NextResponse.redirect(new URL("/", env.appUrl)));
}
