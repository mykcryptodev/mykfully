import type { DB } from "../db";
import { CREDIT_COSTS, debit, postCost, refund } from "../credits";
import type { XClient, XUser } from "./types";

/** Max users a single search may reserve/return (bounds the per-call charge). */
export const SEARCH_MAX = 8;

/** Refund without masking the original error (a refund failure is logged, not thrown). */
async function safeRefund(db: DB, userId: string, amount: number, ref: string): Promise<void> {
  try {
    await refund(db, userId, amount, { ref });
  } catch (e) {
    console.error("[mykfully] refund failed", { userId, amount, ref }, e);
  }
}

/**
 * Wrap an XClient so billable X calls are charged to `userId`'s credits:
 * - postTweet: debit before the call, refund if it throws.
 * - searchUsers / lookupUsernames: reserve the max possible user reads, refund the unused part.
 * - me(): not metered.
 * Admins are handled inside debit/refund (logged as unmetered, never charged).
 * Throws InsufficientCreditsError / CreditCapReachedError before calling X.
 */
export function meter(db: DB, client: XClient, userId: string, ref?: string): XClient {
  async function reserveReads(n: number, endpoint: string, call: () => Promise<XUser[]>): Promise<XUser[]> {
    const per = CREDIT_COSTS.userRead;
    const reserved = n * per;
    const r = ref ?? endpoint;
    await debit(db, userId, reserved, { ref: r, reason: endpoint });
    let users: XUser[];
    try {
      users = await call();
    } catch (e) {
      await safeRefund(db, userId, reserved, r);
      throw e;
    }
    const unused = Math.max(0, n - users.length) * per;
    if (unused > 0) await safeRefund(db, userId, unused, r);
    return users;
  }

  return {
    me: () => client.me(),

    async postTweet(text, replyToId) {
      const cost = postCost(text);
      const r = ref ?? "post";
      await debit(db, userId, cost, { ref: r, reason: "post" });
      try {
        return await client.postTweet(text, replyToId);
      } catch (e) {
        await safeRefund(db, userId, cost, r);
        throw e;
      }
    },

    async searchUsers(query, max) {
      const n = Math.min(Math.max(Math.floor(max ?? SEARCH_MAX), 1), SEARCH_MAX);
      const users = await reserveReads(n, "search", () => client.searchUsers(query, n));
      return users.slice(0, n);
    },

    async lookupUsernames(usernames) {
      const names = [...new Set(usernames.map((u) => u.trim()).filter(Boolean))];
      if (names.length === 0) return [];
      return reserveReads(names.length, "lookup", () => client.lookupUsernames(names));
    },
  };
}

/** The X client for a user, with credit metering. Use this for every user-initiated or scheduled X call. */
export async function getMeteredXClient(userId: string, ref?: string): Promise<XClient> {
  // Lazy imports keep meter() (and its tests) free of the DB/token/crypto modules.
  const [{ getDb }, { getRawXClientForUser }] = await Promise.all([import("../db"), import("./index")]);
  const [db, client] = await Promise.all([getDb(), getRawXClientForUser(userId)]);
  return meter(db, client, userId, ref);
}
