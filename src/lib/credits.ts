import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import type { DB } from "./db";
import { creditLedger, users, type CreditKind, type ThreadPost } from "./db/schema";
import { env, intEnv } from "./env";
import { CreditCapReachedError, InsufficientCreditsError } from "./errors";
import { hasUrl } from "./text";

/** 1 credit ≈ $0.001 of X API spend. Override with CREDIT_COST_* env vars if X changes pricing. */
export const CREDIT_COSTS = {
  get post() {
    return intEnv("CREDIT_COST_POST", 15);
  },
  get postWithUrl() {
    return intEnv("CREDIT_COST_POST_WITH_URL", 200);
  },
  get userRead() {
    return intEnv("CREDIT_COST_USER_READ", 10);
  },
  get ownedRead() {
    return intEnv("CREDIT_COST_OWNED_READ", 1);
  },
};

export function isAdmin(userId: string): boolean {
  return env.adminIds.has(userId);
}

export function postCost(text: string): number {
  return hasUrl(text) ? CREDIT_COSTS.postWithUrl : CREDIT_COSTS.post;
}

/** Credits needed to publish the not-yet-posted, non-empty posts of a thread. */
export function estimateThreadCost(posts: Pick<ThreadPost, "text" | "tweetId">[]): number {
  return posts.filter((p) => !p.tweetId && p.text.trim()).reduce((sum, p) => sum + postCost(p.text), 0);
}

/** db.execute() returns `{ rows }` on PGlite and neon-http (and sometimes a bare array); normalize. */
export function execRows<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  const rows = (res as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

type LedgerOpts = { ref?: string | null; reason?: string | null };

export async function getBalance(db: DB, userId: string): Promise<number> {
  const [row] = await db.select({ credits: users.credits }).from(users).where(eq(users.id, userId));
  return row?.credits ?? 0;
}

/** Total metered (non-admin) net spend over the last 24h across the whole instance. */
async function globalSpend24h(db: DB): Promise<number> {
  const res = await db.execute(sql`
    SELECT COALESCE(-SUM(delta), 0)::int AS spent FROM credit_ledger
    WHERE kind IN ('spend', 'refund') AND unmetered = false AND created_at > now() - interval '24 hours'`);
  return Number(execRows<{ spent: number | string }>(res)[0]?.spent ?? 0);
}

/**
 * Atomically charge `cost` credits (balance check + decrement + ledger row in ONE statement — neon-http has no
 * transactions). Admins are never charged; their spend is logged with `unmetered = true`.
 * Throws InsufficientCreditsError / CreditCapReachedError.
 */
export async function debit(db: DB, userId: string, cost: number, opts: LedgerOpts = {}): Promise<{ balance: number; unmetered: boolean }> {
  if (!Number.isInteger(cost) || cost < 0) throw new Error("invalid cost");
  if (cost === 0) return { balance: await getBalance(db, userId), unmetered: isAdmin(userId) };
  const id = randomUUID();

  if (isAdmin(userId)) {
    const res = await db.execute(sql`
      INSERT INTO credit_ledger (id, user_id, delta, balance_after, kind, reason, ref, unmetered, created_at)
      SELECT ${id}, u.id, ${-cost}, u.credits, 'spend', ${opts.reason ?? null}, ${opts.ref ?? null}, true, clock_timestamp()
      FROM users u WHERE u.id = ${userId}
      RETURNING balance_after`);
    return { balance: Number(execRows<{ balance_after: number }>(res)[0]?.balance_after ?? 0), unmetered: true };
  }

  const cap = env.globalDailyCreditCap;
  if (cap > 0 && (await globalSpend24h(db)) + cost > cap) throw new CreditCapReachedError();

  const res = await db.execute(sql`
    WITH d AS (
      UPDATE users SET credits = credits - ${cost}, updated_at = now()
      WHERE id = ${userId} AND credits >= ${cost}
      RETURNING id, credits
    )
    INSERT INTO credit_ledger (id, user_id, delta, balance_after, kind, reason, ref, unmetered, created_at)
    SELECT ${id}, d.id, ${-cost}, d.credits, 'spend', ${opts.reason ?? null}, ${opts.ref ?? null}, false, clock_timestamp() FROM d
    RETURNING balance_after`);
  const row = execRows<{ balance_after: number }>(res)[0];
  if (!row) throw new InsufficientCreditsError(cost, await getBalance(db, userId));
  return { balance: Number(row.balance_after), unmetered: false };
}

/** Return credits after a failed/partially-used operation. Admin refunds are logged as unmetered. */
export async function refund(db: DB, userId: string, amount: number, opts: LedgerOpts = {}): Promise<void> {
  if (!Number.isInteger(amount) || amount <= 0) return;
  const id = randomUUID();
  if (isAdmin(userId)) {
    await db.execute(sql`
      INSERT INTO credit_ledger (id, user_id, delta, balance_after, kind, reason, ref, unmetered, created_at)
      SELECT ${id}, u.id, ${amount}, u.credits, 'refund', ${opts.reason ?? null}, ${opts.ref ?? null}, true, clock_timestamp()
      FROM users u WHERE u.id = ${userId}`);
    return;
  }
  await db.execute(sql`
    WITH d AS (
      UPDATE users SET credits = credits + ${amount}, updated_at = now() WHERE id = ${userId} RETURNING id, credits
    )
    INSERT INTO credit_ledger (id, user_id, delta, balance_after, kind, reason, ref, unmetered, created_at)
    SELECT ${id}, d.id, ${amount}, d.credits, 'refund', ${opts.reason ?? null}, ${opts.ref ?? null}, false, clock_timestamp() FROM d`);
}

/**
 * Admin grant (delta > 0) or revoke (delta < 0). Balance is clamped at 0; the ledger records the actual change.
 * Returns the new balance, or null if the user doesn't exist.
 */
export async function grant(
  db: DB,
  actorId: string | null,
  userId: string,
  delta: number,
  reason: string | null,
  kind?: CreditKind,
): Promise<number | null> {
  if (!Number.isInteger(delta) || delta === 0) throw new Error("delta must be a non-zero integer");
  const k: CreditKind = kind ?? (delta > 0 ? "grant" : "revoke");
  const id = randomUUID();
  const res = await db.execute(sql`
    WITH old AS (SELECT id, credits FROM users WHERE id = ${userId}),
    d AS (
      UPDATE users SET credits = GREATEST(credits + ${delta}, 0), updated_at = now()
      WHERE id = ${userId} RETURNING id, credits
    )
    INSERT INTO credit_ledger (id, user_id, delta, balance_after, kind, reason, actor_id, unmetered, created_at)
    SELECT ${id}, d.id, d.credits - old.credits, d.credits, ${k}, ${reason}, ${actorId}, false, clock_timestamp()
    FROM d JOIN old ON old.id = d.id
    RETURNING balance_after`);
  const row = execRows<{ balance_after: number }>(res)[0];
  return row ? Number(row.balance_after) : null;
}

/** One-time signup grant; call only when the user row was freshly inserted. */
export async function grantSignup(db: DB, userId: string): Promise<void> {
  const amount = env.signupCredits;
  if (amount > 0) await grant(db, null, userId, amount, "Welcome credits", "signup");
}

export async function listLedger(db: DB, userId: string, limit = 50) {
  return db
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId))
    .orderBy(desc(creditLedger.seq))
    .limit(Math.min(Math.max(limit, 1), 500));
}
