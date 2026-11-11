import { createHash, randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { RateLimitedError } from "@/lib/errors";
import { clientIp } from "@/lib/http";
import { limitNamed } from "@/lib/ratelimit";
import { OAUTH_COOKIE_PATH, oauthCookieName, setSession } from "@/lib/session";
import { X_AUTHORIZE_URL, X_SCOPES, mockLogin, redirectUri } from "@/lib/x";

export const dynamic = "force-dynamic";

const b64url = (b: Buffer) => b.toString("base64url");

function loginError(code: string) {
  const url = new URL("/login", env.appUrl);
  url.searchParams.set("error", code);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  try {
    await limitNamed(await getDb(), "login", clientIp(req));
  } catch (e) {
    if (e instanceof RateLimitedError) return loginError("rate_limited");
    throw e;
  }

  // Mock login is an auth bypass: env.mockX is already off on Vercel production, and under
  // NODE_ENV=production it additionally needs ALLOW_MOCK_LOGIN=1 (local smoke tests only).
  if (env.mockX && env.allowMockLogin) {
    const userId = await mockLogin();
    await setSession(userId);
    return NextResponse.redirect(new URL("/", env.appUrl));
  }

  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48)); // 64 chars, within PKCE's 43-128
  const challenge = b64url(createHash("sha256").update(verifier).digest());

  const url = new URL(X_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.xClientId);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("scope", X_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  const res = NextResponse.redirect(url.toString());
  res.cookies.set(oauthCookieName(), JSON.stringify({ state, verifier }), {
    httpOnly: true,
    secure: env.isProd,
    sameSite: "lax", // must survive the top-level redirect back from x.com
    path: OAUTH_COOKIE_PATH,
    maxAge: 600,
  });
  return res;
}
