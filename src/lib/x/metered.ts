import type { DB } from "../db";
import { CREDIT_COSTS, debit, postCost, refund } from "../credits";
import { AmbiguousPublishError, ReconnectRequiredError } from "../errors";
import { XApiError, type XClient, type XUser } from "./types";

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
 * X definitely did not create the post: a 4xx rejection (incl. 429), except 408 (request timeout, which may
 * have been processed). Anything else (network error, timeout, 5xx, bad 2xx body) is ambiguous.
 */
function isDefiniteRejection(e: unknown): e is XApiError {
  return e instanceof XApiError && e.status >= 400 && e.status < 500 && e.status !== 408;
}

/**
 * Wrap an XClient so billable X calls are charged to `userId`'s credits:
 * - postTweet: debit before the call; refund only on a definite X rejection (4xx except 408). Any other
 *   failure throws AmbiguousPublishError with no refund (the post may exist, so it must not be auto-retried).
 * - requestMedia: meter each request, including status checks. A failure is safe to retry because this
 *   operation never creates a post. Refund only when the request was rejected or never dispatched.
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

    async postTweet(text, replyToId, mediaIds, signal) {
      signal?.throwIfAborted();
      const cost = postCost(text);
      const r = ref ?? "post";
      await debit(db, userId, cost, { ref: r, reason: "post" });
      if (signal?.aborted) {
        await safeRefund(db, userId, cost, r);
        signal.throwIfAborted();
      }
      try {
        return await client.postTweet(text, replyToId, mediaIds, signal);
      } catch (e) {
        if (isDefiniteRejection(e)) {
          await safeRefund(db, userId, cost, r);
          throw e;
        }
        console.error("[mykfully] ambiguous post failure", e instanceof XApiError ? `XApiError ${e.status}` : e instanceof Error ? e.name : typeof e);
        throw new AmbiguousPublishError();
      }
    },

    async requestMedia(request, signal) {
      signal?.throwIfAborted();
      const reason = request.type === "altText" ? "media_metadata" : "media_upload";
      const cost = request.type === "altText" ? CREDIT_COSTS.mediaMetadata : CREDIT_COSTS.mediaUpload;
      const r = ref ?? reason;
      if (cost > 0) await debit(db, userId, cost, { ref: r, reason });
      if (signal?.aborted) {
        await safeRefund(db, userId, cost, r);
        signal.throwIfAborted();
      }
      try {
        return await client.requestMedia(request, signal);
      } catch (e) {
        if (isDefiniteRejection(e) || e instanceof ReconnectRequiredError) await safeRefund(db, userId, cost, r);
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
