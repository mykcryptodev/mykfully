import { env } from "./env";
import { HttpError } from "./errors";

/**
 * CSRF defence for state-changing routes: the request's Origin (or Referer) must be APP_URL.
 * Throws HttpError(403) otherwise. Requests with neither header are rejected too.
 */
export function assertSameOrigin(req: Request): void {
  const expected = new URL(env.appUrl).origin;
  const origin = req.headers.get("origin");
  if (origin) {
    if (origin !== expected) throw new HttpError(403, "Cross-origin request rejected");
    return;
  }
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      if (new URL(referer).origin === expected) return;
    } catch {}
  }
  throw new HttpError(403, "Cross-origin request rejected");
}

/** Require a JSON content-type for requests with a body (blocks "simple" cross-site form posts). */
export function assertJson(req: Request): void {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().startsWith("application/json")) throw new HttpError(415, "Content-Type must be application/json");
}

/** Client IP (Vercel sets x-forwarded-for). */
export function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}
