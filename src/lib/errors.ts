import { z } from "zod";
import { XApiError } from "./x/types";

/** Error with an HTTP status and a safe, user-facing message. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class InsufficientCreditsError extends Error {
  readonly code = "insufficient_credits";
  constructor(
    public needed: number,
    public balance: number,
  ) {
    super(`Not enough credits (need ${needed}, have ${balance})`);
    this.name = "InsufficientCreditsError";
  }
}

export class CreditCapReachedError extends Error {
  readonly code = "credit_cap_reached";
  constructor() {
    super("The instance's daily credit cap has been reached. Try again later.");
    this.name = "CreditCapReachedError";
  }
}

export class RateLimitedError extends Error {
  readonly code = "rate_limited";
  constructor(public retryAfterSec: number) {
    super("Too many requests. Slow down and try again shortly.");
    this.name = "RateLimitedError";
  }
}

/** The user's X authorization is gone (refresh token revoked/expired) — they must log in again. */
export class ReconnectRequiredError extends Error {
  readonly code = "reconnect_required";
  constructor() {
    super("Your X connection expired. Reconnect X to keep publishing.");
    this.name = "ReconnectRequiredError";
  }
}

/**
 * A post may or may not have been published (network error, timeout, X 5xx, unparseable 2xx, or its tweetId
 * couldn't be saved). Never retried automatically, to avoid double posts; credits are not refunded.
 */
export class AmbiguousPublishError extends Error {
  readonly code = "publish_uncertain";
  constructor() {
    super("X may or may not have published this post. Check your X profile before retrying.");
    this.name = "AmbiguousPublishError";
  }
}

/** Errors that must not be retried by the scheduler. */
export function isFatalPublishError(e: unknown): boolean {
  return (
    e instanceof InsufficientCreditsError ||
    e instanceof AmbiguousPublishError ||
    e instanceof ReconnectRequiredError ||
    e instanceof CreditCapReachedError ||
    (e instanceof XApiError && (e.status === 401 || e.status === 403))
  );
}

export type PublicError = { status: number; code: string; message: string; extra?: Record<string, unknown> };

/**
 * Convert any thrown value into something safe to show users / store in `drafts.last_error`.
 * Unknown errors (DB errors can embed SQL + encrypted token params) become "internal_error";
 * details are logged server-side only.
 */
export function toPublicError(e: unknown): PublicError {
  if (e instanceof InsufficientCreditsError)
    return { status: 402, code: e.code, message: e.message, extra: { needed: e.needed, balance: e.balance } };
  if (e instanceof CreditCapReachedError) return { status: 503, code: e.code, message: e.message };
  if (e instanceof RateLimitedError) return { status: 429, code: e.code, message: e.message, extra: { retryAfter: e.retryAfterSec } };
  if (e instanceof ReconnectRequiredError) return { status: 409, code: e.code, message: e.message };
  if (e instanceof AmbiguousPublishError) return { status: 502, code: e.code, message: e.message };
  if (e instanceof HttpError) return { status: e.status, code: "error", message: e.message, extra: e.extra };
  if (e instanceof XApiError) return { status: 502, code: "x_api_error", message: `X API error ${e.status}: ${xErrorTitle(e.body)}` };
  if (e instanceof z.ZodError) return { status: 400, code: "invalid_request", message: "Invalid request" };
  if (e instanceof SyntaxError) return { status: 400, code: "invalid_json", message: "Invalid JSON body" };
  if (e && typeof e === "object" && (e as { name?: string }).name === "UnauthorizedError")
    return { status: 401, code: "unauthorized", message: "Unauthorized" };
  console.error("[mykfully] internal error:", e);
  return { status: 500, code: "internal_error", message: "Something went wrong" };
}

/** Short, safe description from an X API error body. */
function xErrorTitle(body: string): string {
  try {
    const j = JSON.parse(body) as { title?: string; detail?: string; errors?: { message?: string }[] };
    const t = j.detail || j.title || j.errors?.[0]?.message || "request failed";
    return String(t).replace(/[^\x20-\x7E]/g, "").slice(0, 200);
  } catch {
    return "request failed";
  }
}

/** Standard JSON error response for route handlers. */
export function errorResponse(e: unknown): Response {
  const pe = toPublicError(e);
  const headers: Record<string, string> = {};
  if (e instanceof RateLimitedError) headers["Retry-After"] = String(e.retryAfterSec);
  const body: Record<string, unknown> = { error: pe.message, code: pe.code, ...(pe.extra ?? {}) };
  if (e instanceof z.ZodError) body.issues = e.issues.map((i) => ({ path: i.path, message: i.message }));
  return Response.json(body, { status: pe.status, headers });
}
