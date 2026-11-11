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

/**
 * CSRF defence for credit-spending GET routes (a SameSite=Lax cookie rides top-level cross-site navigations).
 * Allows `Sec-Fetch-Site: same-origin`. Browsers without Fetch Metadata fall back to Referer origin === APP_URL.
 * Throws HttpError(403) otherwise.
 */
export function assertSameSiteFetch(req: Request): void {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) {
    if (site === "same-origin") return;
    throw new HttpError(403, "Cross-site request rejected");
  }
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      if (new URL(referer).origin === new URL(env.appUrl).origin) return;
    } catch {}
  }
  throw new HttpError(403, "Cross-site request rejected");
}

/** Require a JSON content-type for requests with a body (blocks "simple" cross-site form posts). */
export function assertJson(req: Request): void {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().startsWith("application/json")) throw new HttpError(415, "Content-Type must be application/json");
}

/**
 * Client IP for rate-limit keys. Prefers Vercel's own header (not client-spoofable), then x-real-ip,
 * then the first x-forwarded-for entry.
 */
export function clientIp(req: Request): string {
  const first = (h: string) => (req.headers.get(h) ?? "").split(",")[0]?.trim();
  return first("x-vercel-forwarded-for") || first("x-real-ip") || first("x-forwarded-for") || "unknown";
}
