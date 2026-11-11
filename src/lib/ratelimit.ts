import { lt, sql } from "drizzle-orm";
import type { DB } from "./db";
import { rateLimits } from "./db/schema";
import { RateLimitedError } from "./errors";

export const LIMITS = {
  search: { max: 30, windowSec: 60 },
  publish: { max: 10, windowSec: 60 },
  draftCreate: { max: 60, windowSec: 60 },
  login: { max: 20, windowSec: 60 },
  callback: { max: 20, windowSec: 60 },
  admin: { max: 60, windowSec: 60 },
  purchase: { max: 10, windowSec: 60 },
} as const;

/**
 * Fixed-window rate limit backed by Postgres (works across serverless instances).
 * Throws RateLimitedError when `key` exceeds `max` hits in the current window.
 */
export async function limit(db: DB, key: string, max: number, windowSec: number): Promise<void> {
  const nowMs = Date.now();
  const windowMs = windowSec * 1000;
  const windowStart = new Date(Math.floor(nowMs / windowMs) * windowMs);
  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { count: sql`${rateLimits.count} + 1` } })
    .returning({ count: rateLimits.count });
  if (Math.random() < 0.01) {
    // opportunistic cleanup of old windows
    await db.delete(rateLimits).where(lt(rateLimits.windowStart, new Date(nowMs - 86_400_000))).catch(() => {});
  }
  if ((row?.count ?? 0) > max) {
    throw new RateLimitedError(Math.max(1, Math.ceil((windowStart.getTime() + windowMs - nowMs) / 1000)));
  }
}

export function limitNamed(db: DB, name: keyof typeof LIMITS, subject: string): Promise<void> {
  const l = LIMITS[name];
  return limit(db, `${name}:${subject}`, l.max, l.windowSec);
}
