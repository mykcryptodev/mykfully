import { desc, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { creditLedger, users } from "@/lib/db/schema";
import { isAdmin } from "@/lib/credits";
import { HttpError } from "@/lib/errors";
import { limitNamed } from "@/lib/ratelimit";
import { requireUserId } from "@/lib/session";

/** Session + admin check. Non-admins get 404 so the admin surface isn't revealed. Also rate-limited. */
export async function requireAdmin(db: DB): Promise<string> {
  const userId = await requireUserId();
  if (!isAdmin(userId)) throw new HttpError(404, "Not found");
  await limitNamed(db, "admin", userId);
  return userId;
}

type LedgerRow = typeof creditLedger.$inferSelect;

/** Ledger row → JSON. `actorId` (an admin's X id) is only included for admin views. */
export function serializeLedger(r: LedgerRow, opts: { includeActor?: boolean } = {}) {
  return {
    id: r.id,
    delta: r.delta,
    balanceAfter: r.balanceAfter,
    kind: r.kind,
    reason: r.reason,
    ref: r.ref,
    ...(opts.includeActor ? { actorId: r.actorId } : {}),
    unmetered: r.unmetered,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * All users (newest activity first, max 500) with net X spend over 7/30 days
 * (metered spend + refund rows; admins' unmetered spend excluded), in one aggregate query.
 */
export async function listUsersWithSpend(db: DB) {
  const spend = db
    .select({
      userId: creditLedger.userId,
      spent7d: sql<number>`COALESCE(-SUM(${creditLedger.delta}) FILTER (WHERE ${creditLedger.createdAt} > now() - interval '7 days'), 0)::int`.as(
        "spent7d",
      ),
      spent30d: sql<number>`COALESCE(-SUM(${creditLedger.delta}), 0)::int`.as("spent30d"),
    })
    .from(creditLedger)
    .where(sql`${creditLedger.kind} IN ('spend', 'refund') AND ${creditLedger.unmetered} = false AND ${creditLedger.createdAt} > now() - interval '30 days'`)
    .groupBy(creditLedger.userId)
    .as("spend");

  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      name: users.name,
      profileImageUrl: users.profileImageUrl,
      credits: users.credits,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
      spent7d: spend.spent7d,
      spent30d: spend.spent30d,
    })
    .from(users)
    .leftJoin(spend, sql`${spend.userId} = ${users.id}`)
    .orderBy(desc(users.updatedAt))
    .limit(500);

  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    name: r.name,
    profileImageUrl: r.profileImageUrl,
    credits: r.credits,
    isAdmin: isAdmin(r.id),
    spent7d: Number(r.spent7d ?? 0),
    spent30d: Number(r.spent30d ?? 0),
    createdAt: r.createdAt.toISOString(),
    lastSeen: r.updatedAt ? r.updatedAt.toISOString() : null,
  }));
}
