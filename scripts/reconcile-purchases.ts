// Reconciles x402 credit purchases that were left "pending" (the server never learned whether the payment
// settled). The chain decides: a purchase is credited only if a successful transaction used its authorization
// AND transferred the exact USDC amount to the pay-to address; an authorization that expired unused is marked failed.
//
// Manual for v1. Run it with the same env as the app (DATABASE_URL, X402_NETWORK, optional X402_RPC_URL):
//
//   pnpm purchases:reconcile                      # pending purchases older than 5 minutes
//   pnpm purchases:reconcile --dry-run            # report only, write nothing
//   pnpm purchases:reconcile --include-failed     # also re-check purchases marked failed
//   pnpm purchases:reconcile --id <purchaseId> --tx <0xhash>   # check one purchase against a known transaction
//
// Without DATABASE_URL it opens the local PGlite database (stop `pnpm dev` first: PGlite is single-process).
import { getDb } from "../src/lib/db";
import { env } from "../src/lib/env";
import { X402_NETWORKS } from "../src/lib/payments/config";
import { createViemChainReader, reconcilePurchases } from "../src/lib/payments/reconcile";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
  const network = env.x402Network;
  if (network !== "base" && network !== "base-sepolia") {
    console.error('[reconcile] X402_NETWORK must be "base" or "base-sepolia"');
    process.exit(1);
  }
  const id = value("--id");
  const tx = value("--tx");
  if ((id && !tx) || (tx && !id)) {
    console.error("[reconcile] --id and --tx must be used together");
    process.exit(1);
  }
  const db = await getDb();
  const results = await reconcilePurchases(db, createViemChainReader({ network }, env.x402RpcUrl), {
    network: X402_NETWORKS[network].caip2,
    includeFailed: flag("--include-failed"),
    dryRun: flag("--dry-run"),
    only: id && tx ? { id, txHash: tx } : undefined,
  });
  if (results.length === 0) console.log(`[reconcile] nothing to do on ${network}`);
  for (const r of results) {
    console.log(`[reconcile] ${r.id} user=${r.userId} ${r.status} → ${r.action}${r.txHash ? ` tx=${r.txHash}` : ""}${r.note ? ` (${r.note})` : ""}`);
  }
  if (flag("--dry-run")) console.log("[reconcile] dry run: nothing was written");
  process.exit(results.some((r) => r.action === "needs_review") ? 2 : 0);
}

main().catch((e) => {
  console.error("[reconcile] failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
