import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import { execRows, getBalance } from "../credits";
import type { DB } from "../db";
import { creditPurchases, type PurchaseStatus } from "../db/schema";
import { HttpError } from "../errors";
import { PACKS, packAmountAtomic, type PackId, type PurchaseConfig } from "./config";
import { buildChallenge, buildPackRequirements, parsePayment, PaymentRejectedError, settlePayment, verifyPayment } from "./x402";

/**
 * Purchase bookkeeping. neon-http has no transactions, so every step is ONE statement:
 * - claimPending: INSERT … ON CONFLICT DO NOTHING — the UNIQUE(network, payer, nonce) index makes a signed
 *   authorization usable once, ever.
 * - creditPurchase: one CTE that flips the row to `settled`, adds the credits and writes the ledger row.
 *   Guarded by status and by tx hash, so it can run any number of times and credits at most once.
 */

export type ClaimInput = {
  userId: string;
  packId: PackId;
  cfg: PurchaseConfig;
  /** Lowercase payer address + authorization nonce. */
  payer: string;
  nonce: string;
};

/** Record a not-yet-settled payment. Returns the purchase id, or null if this authorization was already seen (replay). */
export async function claimPending(db: DB, input: ClaimInput): Promise<string | null> {
  const id = randomUUID();
  const rows = await db
    .insert(creditPurchases)
    .values({
      id,
      userId: input.userId,
      packId: input.packId,
      credits: PACKS[input.packId].credits,
      amountAtomic: packAmountAtomic(input.packId),
      network: input.cfg.caip2,
      asset: input.cfg.asset.toLowerCase(),
      payTo: input.cfg.payTo.toLowerCase(),
      payer: input.payer.toLowerCase(),
      nonce: input.nonce.toLowerCase(),
      status: "pending",
    })
    .onConflictDoNothing()
    .returning({ id: creditPurchases.id });
  return rows[0]?.id ?? null;
}

export type CreditResult =
  /** Credits were added by this call. */
  | { status: "credited"; balance: number }
  /** This purchase was already settled with the same tx hash; nothing changed. */
  | { status: "already_credited"; balance: number }
  /** Not credited: the tx hash already paid for another purchase, or the row is missing / not in an allowed status. */
  | { status: "rejected"; reason: "duplicate_tx" | "not_found" | "bad_status" };

/**
 * Settle a purchase: mark the row settled with `txHash`, add its credits to the user and append a
 * `purchase` ledger row (ref = tx hash) — atomically, at most once per purchase and once per tx hash.
 * `from` lists the statuses that may be settled ("failed" only for the reconcile script's re-check).
 */
export async function creditPurchase(db: DB, purchaseId: string, txHash: string, from: PurchaseStatus[] = ["pending"]): Promise<CreditResult> {
  const tx = txHash.toLowerCase();
  const statusOk = from.includes("failed") ? sql`status IN ('pending', 'failed')` : sql`status = 'pending'`;
  const res = await db.execute(sql`
    WITH p AS (
      UPDATE credit_purchases SET status = 'settled', tx_hash = ${tx}, settled_at = now()
      WHERE id = ${purchaseId}
        AND ${statusOk}
        AND NOT EXISTS (SELECT 1 FROM credit_purchases o WHERE o.tx_hash = ${tx})
      RETURNING user_id, credits, pack_id
    ),
    u AS (
      UPDATE users SET credits = users.credits + p.credits, updated_at = now()
      FROM p WHERE users.id = p.user_id
      RETURNING users.id, users.credits AS balance, p.credits AS delta, p.pack_id
    )
    INSERT INTO credit_ledger (id, user_id, delta, balance_after, kind, reason, ref, unmetered, created_at)
    SELECT ${randomUUID()}, u.id, u.delta, u.balance, 'purchase', 'Bought credits with USDC (' || u.pack_id || ')', ${tx}, false, clock_timestamp()
    FROM u
    RETURNING balance_after`);
  const row = execRows<{ balance_after: number | string }>(res)[0];
  if (row) return { status: "credited", balance: Number(row.balance_after) };

  const [existing] = await db.select().from(creditPurchases).where(eq(creditPurchases.id, purchaseId));
  if (!existing) return { status: "rejected", reason: "not_found" };
  if (existing.status === "settled" && existing.txHash === tx) {
    return { status: "already_credited", balance: await getBalance(db, existing.userId) };
  }
  const [other] = await db.select({ id: creditPurchases.id }).from(creditPurchases).where(eq(creditPurchases.txHash, tx));
  return { status: "rejected", reason: other ? "duplicate_tx" : "bad_status" };
}

/** Mark a pending purchase failed (definite non-settlement). Never touches settled rows. */
export async function markFailed(db: DB, purchaseId: string): Promise<boolean> {
  const rows = await db
    .update(creditPurchases)
    .set({ status: "failed" })
    .where(and(eq(creditPurchases.id, purchaseId), eq(creditPurchases.status, "pending")))
    .returning({ id: creditPurchases.id });
  return rows.length > 0;
}

/** One purchase by id (reconcile script's --id). */
export async function getPurchase(db: DB, id: string) {
  const [row] = await db.select().from(creditPurchases).where(eq(creditPurchases.id, id));
  return row ?? null;
}

/** Purchases in the given statuses created before `olderThan`, newest first (reconcile script). */
export async function listPurchases(db: DB, statuses: PurchaseStatus[], olderThan: Date, network: string, limit = 500) {
  return db
    .select()
    .from(creditPurchases)
    .where(and(inArray(creditPurchases.status, statuses), eq(creditPurchases.network, network), lt(creditPurchases.createdAt, olderThan)))
    .orderBy(desc(creditPurchases.createdAt))
    .limit(limit);
}

export type PurchaseOutcome =
  /** 402: no payment yet, or the payment was rejected (`error` says why). Nothing was charged. */
  | { kind: "payment_required"; challenge: PaymentRequired; error?: string }
  /** 200: paid on-chain and credited. */
  | { kind: "settled"; balance: number; credits: number; txHash: string; settlement: SettleResponse }
  /** 202: submitted but not confirmed. NOT credited; scripts/reconcile-purchases.ts resolves it. */
  | { kind: "pending"; purchaseId: string };

/**
 * The whole purchase flow for POST /api/credits/purchase (after auth, CSRF and rate limiting).
 * `paymentHeader` is the raw PAYMENT-SIGNATURE value or null. Throws HttpError for 409 (replay / duplicate tx)
 * and 502 (facilitator unreachable before anything was submitted).
 */
export async function purchaseCredits(
  db: DB,
  cfg: PurchaseConfig,
  userId: string,
  packId: PackId,
  paymentHeader: string | null,
  resourceUrl: string,
): Promise<PurchaseOutcome> {
  let req;
  try {
    req = await buildPackRequirements(cfg, packId);
  } catch (e) {
    console.error("[mykfully] x402 setup failed:", e instanceof Error ? e.message : "error");
    throw new HttpError(502, "The payment service is unavailable. Try again shortly.", { code: "facilitator_unavailable" });
  }
  const challenge = async (error?: string): Promise<PurchaseOutcome> => ({
    kind: "payment_required",
    challenge: await buildChallenge(cfg, packId, req, resourceUrl, error),
    error,
  });
  if (!paymentHeader) return challenge();

  let payment;
  try {
    payment = await parsePayment(cfg, req, paymentHeader);
  } catch (e) {
    if (e instanceof PaymentRejectedError) return challenge(e.reason);
    throw e;
  }

  let invalid: string | null;
  try {
    invalid = await verifyPayment(cfg, req, payment);
  } catch (e) {
    console.error("[mykfully] x402 verify failed:", e instanceof Error ? e.name : "error");
    throw new HttpError(502, "The payment service is unavailable. You were not charged.", { code: "facilitator_unavailable" });
  }
  if (invalid) return challenge(invalid);

  // Claim BEFORE settling: from here on the authorization can never be credited twice.
  const purchaseId = await claimPending(db, { userId, packId, cfg, payer: payment.payer, nonce: payment.nonce });
  if (!purchaseId) {
    throw new HttpError(409, "This payment was already submitted. If you were charged, your credits will arrive shortly.", {
      code: "payment_replayed",
    });
  }

  const outcome = await settlePayment(cfg, req, payment);
  if (outcome.kind === "failed") {
    await markFailed(db, purchaseId);
    return challenge(outcome.reason);
  }
  if (outcome.kind === "uncertain") return { kind: "pending", purchaseId };

  const credited = await creditPurchase(db, purchaseId, outcome.txHash);
  if (credited.status === "rejected") {
    // The facilitator reported a transaction that already paid for another purchase. Never credit it again;
    // the row stays pending for the reconcile script / manual review.
    console.error(`[mykfully] x402 purchase ${purchaseId} not credited: ${credited.reason}`);
    throw new HttpError(409, "This payment could not be credited automatically. Contact the admin of this instance.", {
      code: "payment_not_credited",
    });
  }
  return { kind: "settled", balance: credited.balance, credits: PACKS[packId].credits, txHash: outcome.txHash, settlement: outcome.response };
}
