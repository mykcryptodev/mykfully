import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { setSession } from "@/lib/session";
import { X_AUTHORIZE_URL, X_SCOPES, mockLogin, redirectUri } from "@/lib/x";

export const dynamic = "force-dynamic";
const OAUTH_COOKIE = "myk_oauth";

const b64url = (b: Buffer) => b.toString("base64url");

export async function GET() {
  if (env.mockX) {
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
  res.cookies.set(OAUTH_COOKIE, JSON.stringify({ state, verifier }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax", // must survive the top-level redirect back from x.com
    path: "/api/auth",
    maxAge: 600,
  });
  return res;
}
