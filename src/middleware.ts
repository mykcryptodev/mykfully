import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

// Edge runtime: no db / node imports here (so not src/lib/session.ts). Signature-only check;
// route handlers enforce session_version via getSession().
const IS_PROD = process.env.NODE_ENV === "production";
/** Must match sessionCookieName() in src/lib/session.ts. */
const SESSION_COOKIE = IS_PROD ? "__Host-myk_session" : "myk_session";
const MIN_SECRET_BYTES = 32;

async function isAuthed(req: NextRequest, secret: Uint8Array): Promise<boolean> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    return !!payload.sub;
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const raw = process.env.SESSION_SECRET ?? "";
  const secret = new TextEncoder().encode(raw);
  if (secret.length < MIN_SECRET_BYTES) {
    // Fail closed: a short/missing secret makes sessions forgeable.
    console.error("[middleware] SESSION_SECRET is missing or shorter than 32 bytes; refusing requests");
    return new NextResponse("Server misconfigured", { status: 500 });
  }

  if (await isAuthed(req, secret)) return NextResponse.next();
  const url = req.nextUrl.clone();
  let res: NextResponse;
  if (req.nextUrl.pathname === "/") {
    // Signed-out visitors see the landing page at the root URL itself, rather than being
    // bounced to /login (a redirect-to-login on a bare domain looks phishy to Safe Browsing).
    url.pathname = "/login";
    res = NextResponse.rewrite(url);
  } else {
    const next = req.nextUrl.pathname + req.nextUrl.search;
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(next)}`;
    res = NextResponse.redirect(url);
  }
  if (req.cookies.has(SESSION_COOKIE)) {
    // drop invalid/expired cookie; __Host- cookies can only be cleared with matching attributes
    res.cookies.set(SESSION_COOKIE, "", { path: "/", secure: IS_PROD, httpOnly: true, sameSite: "lax", maxAge: 0 });
  }
  return res;
}

export const config = {
  // Everything except /login, /api/**, Next internals, and real static asset extensions.
  matcher: ["/((?!login(?:/|$)|privacy(?:/|$)|api/|_next/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|woff2?)$).*)"],
};
