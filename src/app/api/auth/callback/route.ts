import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { setSession } from "@/lib/session";
import { exchangeAuthCode, saveTokens, upsertUser } from "@/lib/x";
import { createRealXClient } from "@/lib/x/real";

export const dynamic = "force-dynamic";
const OAUTH_COOKIE = "myk_oauth";

function fail(error: string) {
  const url = new URL("/login", env.appUrl);
  url.searchParams.set("error", error);
  const res = NextResponse.redirect(url);
  res.cookies.set(OAUTH_COOKIE, "", { path: "/api/auth", maxAge: 0 });
  return res;
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const error = p.get("error");
  if (error) return fail(p.get("error_description") || error);

  const code = p.get("code");
  const state = p.get("state");
  if (!code || !state) return fail("missing_code");

  let stored: { state?: string; verifier?: string } = {};
  try {
    stored = JSON.parse(req.cookies.get(OAUTH_COOKIE)?.value ?? "{}");
  } catch {
    /* fallthrough */
  }
  if (!stored.state || !stored.verifier || !safeEqual(stored.state, state)) return fail("invalid_state");

  try {
    const tokens = await exchangeAuthCode(code, stored.verifier);
    const me = await createRealXClient(tokens.accessToken).me();
    await upsertUser(me);
    await saveTokens(me.id, tokens);
    await setSession(me.id);
  } catch (err) {
    console.error("[auth/callback] login failed", err);
    return fail("login_failed");
  }

  const res = NextResponse.redirect(new URL("/", env.appUrl));
  res.cookies.set(OAUTH_COOKIE, "", { path: "/api/auth", maxAge: 0 });
  return res;
}
