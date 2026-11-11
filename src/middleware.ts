import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

// Edge runtime: no db / node imports here.
const SESSION_COOKIE = "myk_session";

async function isAuthed(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const secret = process.env.SESSION_SECRET;
  if (!token || !secret) return false;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ["HS256"] });
    return !!payload.sub;
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  if (await isAuthed(req)) return NextResponse.next();
  const url = req.nextUrl.clone();
  const next = req.nextUrl.pathname + req.nextUrl.search;
  url.pathname = "/login";
  url.search = next && next !== "/" ? `?next=${encodeURIComponent(next)}` : "";
  const res = NextResponse.redirect(url);
  if (req.cookies.has(SESSION_COOKIE)) res.cookies.delete(SESSION_COOKIE); // drop invalid/expired cookie
  return res;
}

export const config = {
  // Everything except /login, /api/**, Next internals, and files with an extension (static assets).
  matcher: ["/((?!login|api/|_next/|favicon\\.ico|.*\\.[\\w]+$).*)"],
};
