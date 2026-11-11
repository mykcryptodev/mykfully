import { createPublicClient, http, parseAbi, parseEventLogs, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { DB } from "../db";
import type { creditPurchases } from "../db/schema";
import type { PurchaseConfig } from "./config";
import { creditPurchase, getPurchase, listPurchases, markFailed } from "./purchases";
import { isTxHash } from "./x402";

/**
 * Manual reconciliation of purchases whose settlement outcome the server never learned (202 "pending"):
 * the chain is the source of truth. Used by scripts/reconcile-purchases.ts; not imported by the app.
 *
 * A purchase is credited only when a successful transaction contains BOTH, emitted by the USDC contract:
 *   AuthorizationUsed(payer, nonce)  and  Transfer(payer → payTo, exactly the pack amount).
 * `authorizationState` alone is not proof of payment: the payer could burn the nonce with a different
 * authorization (other recipient/amount) or cancel it.
 */

export type PurchaseRow = typeof creditPurchases.$inferSelect;

export interface ChainReader {
  /** USDC `authorizationState(payer, nonce)`: has this authorization nonce been used or canceled? */
  authorizationUsed(row: PurchaseRow): Promise<boolean>;
  /** Find the transaction that used the authorization (near the purchase time). Null if not found. */
  findAuthorizationTx(row: PurchaseRow): Promise<string | null>;
  /** True if `txHash` succeeded and paid `row.amountAtomic` USDC from `row.payer` to `row.payTo` using `row.nonce`. */
  txPaysPurchase(row: PurchaseRow, txHash: string): Promise<boolean>;
}

const usdcAbi = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

const sameAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Chain reader backed by a viem public client (Base / Base Sepolia). */
export function createViemChainReader(cfg: Pick<PurchaseConfig, "network">, rpcUrl?: string | null): ChainReader {
  const client = createPublicClient({ chain: cfg.network === "base" ? base : baseSepolia, transport: http(rpcUrl ?? undefined) }) as PublicClient;
  const hex = (s: string) => s as `0x${string}`;
  return {
    authorizationUsed: (row) =>
      client.readContract({ address: hex(row.asset), abi: usdcAbi, functionName: "authorizationState", args: [hex(row.payer), hex(row.nonce)] }),

    async txPaysPurchase(row, txHash) {
      const receipt = await client.getTransactionReceipt({ hash: hex(txHash) });
      if (receipt.status !== "success") return false;
      const logs = parseEventLogs({ abi: usdcAbi, logs: receipt.logs.filter((l) => sameAddr(l.address, row.asset)) });
      const used = logs.some(
        (l) => l.eventName === "AuthorizationUsed" && sameAddr(l.args.authorizer, row.payer) && l.args.nonce.toLowerCase() === row.nonce,
      );
      const paid = logs.some(
        (l) => l.eventName === "Transfer" && sameAddr(l.args.from, row.payer) && sameAddr(l.args.to, row.payTo) && l.args.value === BigInt(row.amountAtomic),
      );
      return used && paid;
    },

    async findAuthorizationTx(row) {
      // The facilitator submits the transfer after the row is created and before the authorization expires
      // (≤ 5 minutes later), so search the blocks from 2 minutes before to 8 minutes after `created_at`.
      const latest = await client.getBlock();
      const span = latest.number > BigInt(5000) ? BigInt(5000) : latest.number;
      const past = await client.getBlock({ blockNumber: latest.number - span });
      const secPerBlock = Math.max(Number(latest.timestamp - past.timestamp) / Math.max(Number(span), 1), 0.05);
      const clamp = (n: bigint) => (n < BigInt(0) ? BigInt(0) : n > latest.number ? latest.number : n);
      const blockAt = async (ts: number): Promise<bigint> => {
        if (ts >= Number(latest.timestamp)) return latest.number;
        let n = clamp(latest.number - BigInt(Math.ceil((Number(latest.timestamp) - ts) / secPerBlock)));
        for (let i = 0; i < 4; i++) {
          const diff = ts - Number((await client.getBlock({ blockNumber: n })).timestamp);
          if (Math.abs(diff) <= 2) break;
          n = clamp(n + BigInt(Math.round(diff / secPerBlock)));
        }
        return n;
      };
      const created = Math.floor(row.createdAt.getTime() / 1000);
      const pad = BigInt(50);
      let from = clamp((await blockAt(created - 120)) - pad);
      const to = clamp((await blockAt(created + 8 * 60)) + pad);
      // Public RPCs only allow tiny eth_getLogs ranges (~100 blocks); shrink the chunk until the node accepts it.
      let chunk = BigInt(2000);
      while (from <= to) {
        const end = from + chunk - BigInt(1) < to ? from + chunk - BigInt(1) : to;
        try {
          const logs = await client.getLogs({
            address: hex(row.asset),
            event: usdcAbi[1],
            args: { authorizer: hex(row.payer), nonce: hex(row.nonce) },
            fromBlock: from,
            toBlock: end,
          });
          if (logs[0]?.transactionHash) return logs[0].transactionHash;
          from = end + BigInt(1);
        } catch (e) {
          if (chunk <= BigInt(50)) throw e;
          chunk = chunk / BigInt(2);
        }
      }
      return null;
    },
  };
}

export type ReconcileAction = "credited" | "already_credited" | "failed" | "waiting" | "needs_review";
export type ReconcileResult = { id: string; userId: string; status: string; action: ReconcileAction; txHash?: string; note?: string };

export type ReconcileOptions = {
  /** CAIP-2 network to process (rows on other networks are left alone). */
  network: string;
  /** Only rows older than this are looked at. Default 5 minutes. */
  minAgeMs?: number;
  /**
   * An unused authorization is only declared dead after this age. Default 6 minutes: authorizations are valid for
   * at most 5 minutes from signing (MAX_TIMEOUT_SECONDS), plus a margin for clock/block-time skew.
   */
  failAfterMs?: number;
  /** Also re-check `failed` rows (credits them if the payment did land on-chain after all). */
  includeFailed?: boolean;
  /** Report what would happen without writing. */
  dryRun?: boolean;
  /** Check one purchase against a known transaction hash instead of searching for it. */
  only?: { id: string; txHash: string };
  now?: Date;
};

/** Reconcile pending (and optionally failed) purchases against the chain. Safe to run repeatedly and concurrently. */
export async function reconcilePurchases(db: DB, chain: ChainReader, opts: ReconcileOptions): Promise<ReconcileResult[]> {
  const now = opts.now ?? new Date();
  const minAgeMs = opts.minAgeMs ?? 5 * 60_000;
  const failAfterMs = Math.max(opts.failAfterMs ?? 6 * 60_000, minAgeMs);
  let rows: PurchaseRow[];
  if (opts.only) {
    // A named purchase is looked up directly (any age); settled rows and other networks are left alone.
    const row = await getPurchase(db, opts.only.id);
    rows = row && row.status !== "settled" && row.network === opts.network ? [row] : [];
  } else {
    rows = await listPurchases(db, opts.includeFailed ? ["pending", "failed"] : ["pending"], new Date(now.getTime() - minAgeMs), opts.network);
  }

  const out: ReconcileResult[] = [];
  for (const row of rows) {
    const res: ReconcileResult = { id: row.id, userId: row.userId, status: row.status, action: "waiting" };
    try {
      const used = await chain.authorizationUsed(row);
      if (!used) {
        const expired = now.getTime() - row.createdAt.getTime() >= failAfterMs;
        if (row.status === "failed") res.note = "authorization unused";
        else if (!expired) res.note = "authorization unused but may still be valid";
        else {
          res.action = "failed";
          res.note = "authorization expired unused";
          if (!opts.dryRun) await markFailed(db, row.id);
        }
      } else {
        const hint = opts.only?.txHash;
        const txHash = hint && isTxHash(hint) ? hint.toLowerCase() : await chain.findAuthorizationTx(row);
        if (!txHash) {
          res.action = "needs_review";
          res.note = "authorization used on-chain but its transaction wasn't found; re-run with --id and --tx";
        } else if (!(await chain.txPaysPurchase(row, txHash))) {
          res.action = "needs_review";
          res.txHash = txHash;
          res.note = "authorization used, but not by a matching USDC transfer to the pay-to address (not credited)";
        } else {
          res.txHash = txHash;
          if (opts.dryRun) res.action = "credited";
          else {
            const c = await creditPurchase(db, row.id, txHash, ["pending", "failed"]);
            if (c.status === "rejected") {
              res.action = "needs_review";
              res.note = `not credited: ${c.reason}`;
            } else res.action = c.status;
          }
        }
      }
    } catch (e) {
      res.action = "needs_review";
      res.note = `error: ${e instanceof Error ? e.message.split("\n")[0] : "unknown"}`;
    }
    out.push(res);
  }
  return out;
}
