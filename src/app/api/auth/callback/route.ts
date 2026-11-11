import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
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
function fail(code: "denied" | "login_failed" | "state_mismatch") {
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

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;

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
    await upsertUser(me);
    await saveTokens(me.id, tokens); // also clears needs_reconnect / refreshing_until
    await setSession(me.id);
  } catch (err) {
    console.error(`[auth/callback] login failed: ${describe(err)}`);
    return fail("login_failed");
  }

  return clearOauthCookie(NextResponse.redirect(new URL("/", env.appUrl)));
}
