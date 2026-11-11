import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";

const state = vi.hoisted(() => ({ db: null as unknown, userId: null as string | null }));

vi.mock("@/lib/db", () => ({ getDb: async () => state.db, schema: {} }));
vi.mock("@/lib/session", () => ({
  requireUserId: async () => {
    if (!state.userId) throw Object.assign(new Error("Unauthorized"), { name: "UnauthorizedError" });
    return state.userId;
  },
}));

import { GET as creditsRoute } from "@/app/api/credits/route";
import { POST as purchaseRoute } from "@/app/api/credits/purchase/route";
import { getBalance, listLedger } from "@/lib/credits";
import { getPurchaseConfig } from "@/lib/payments/config";
import { claimPending, creditPurchase } from "@/lib/payments/purchases";
import { reconcilePurchases, type ChainReader } from "@/lib/payments/reconcile";
import { setFacilitatorClient } from "@/lib/payments/x402";
import { NO_WALLET_MESSAGE, payWithWallet } from "@/components/credits/payWithWallet";
import type { PurchaseInfo } from "@/components/lib/api";

const ORIGIN = "http://localhost:3000";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0x2222222222222222222222222222222222222222";
const SEPOLIA = "eip155:84532";
const SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

/** Facilitator double: records what the server asks it to verify/settle and returns scripted answers. */
class StubFacilitator implements FacilitatorClient {
  verifyCalls: { payload: PaymentPayload; req: PaymentRequirements }[] = [];
  settleCalls: { payload: PaymentPayload; req: PaymentRequirements }[] = [];
  verifyImpl: () => Promise<VerifyResponse> = async () => ({ isValid: true });
  settleImpl: () => Promise<SettleResponse> = async () => ({ success: true, transaction: tx(this.settleCalls.length), network: SEPOLIA });
  async verify(payload: PaymentPayload, req: PaymentRequirements) {
    this.verifyCalls.push({ payload, req });
    return this.verifyImpl();
  }
  async settle(payload: PaymentPayload, req: PaymentRequirements) {
    this.settleCalls.push({ payload, req });
    return this.settleImpl();
  }
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: SEPOLIA as `${string}:${string}` }], extensions: [], signers: {} };
  }
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  purchaseRoute(
    new Request(`${ORIGIN}/api/credits/purchase`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );

const account = privateKeyToAccount(generatePrivateKey());
const wallet = new x402HTTPClient(
  x402Client.fromConfig({ schemes: [{ network: SEPOLIA, client: new ExactEvmScheme(account) }], spendControls: { maxAmountPerPayment: "$20" } }),
);

/** POST without payment → the decoded 402 challenge. */
async function challengeFor(packId: string): Promise<PaymentRequired> {
  const res = await post({ packId });
  expect(res.status).toBe(402);
  return wallet.getPaymentRequiredResponse((n) => res.headers.get(n), await res.json());
}

/** Sign a real EIP-3009 payment for the pack's challenge (optionally tampering with challenge or payload). */
async function signedHeaders(
  packId: string,
  tamper: { challenge?: (c: PaymentRequired) => void; payload?: (p: PaymentPayload) => void } = {},
): Promise<Record<string, string>> {
  const challenge = await challengeFor(packId);
  tamper.challenge?.(challenge);
  const payload = await wallet.createPaymentPayload(challenge);
  tamper.payload?.(payload);
  return wallet.encodePaymentSignatureHeader(payload);
}

const purchases = () => db.select().from(schema.creditPurchases);

let db: DB;
let fac: StubFacilitator;
beforeEach(async () => {
  const pg = drizzle(new PGlite(), { schema });
  await migrate(pg, { migrationsFolder: "./drizzle" });
  db = pg as unknown as DB;
  state.db = db;
  state.userId = "u1";
  await db.insert(schema.users).values([
    { id: "u1", username: "alice", name: "Alice", credits: 100 },
    { id: "u2", username: "bob", name: "Bob" },
  ]);
  delete process.env.APP_URL;
  process.env.PAY_TO_ADDRESS = PAY_TO;
  process.env.X402_NETWORK = "base-sepolia";
  fac = new StubFacilitator();
  setFacilitatorClient(fac);
});
afterEach(() => {
  for (const k of ["PAY_TO_ADDRESS", "X402_NETWORK", "CDP_API_KEY_ID", "CDP_API_KEY_SECRET"]) delete process.env[k];
  setFacilitatorClient(null);
});

describe("purchase config", () => {
  it("is off unless fully and validly configured", () => {
    expect(getPurchaseConfig()).toMatchObject({ network: "base-sepolia", caip2: SEPOLIA, asset: SEPOLIA_USDC, facilitator: { kind: "x402.org" } });
    process.env.X402_NETWORK = "ethereum";
    expect(getPurchaseConfig()).toBeNull();
    process.env.X402_NETWORK = "base"; // mainnet needs CDP keys
    expect(getPurchaseConfig()).toBeNull();
    process.env.CDP_API_KEY_ID = "id";
    process.env.CDP_API_KEY_SECRET = "secret";
    expect(getPurchaseConfig()).toMatchObject({ caip2: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", facilitator: { kind: "cdp" } });
    process.env.PAY_TO_ADDRESS = "0x1234";
    expect(getPurchaseConfig()).toBeNull();
    process.env.PAY_TO_ADDRESS = "0x0000000000000000000000000000000000000000";
    expect(getPurchaseConfig()).toBeNull();
    process.env.PAY_TO_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02914"; // bad EIP-55 checksum (typo)
    expect(getPurchaseConfig()).toBeNull();
    delete process.env.PAY_TO_ADDRESS;
    expect(getPurchaseConfig()).toBeNull();
  });

  it("GET /api/credits reports the packs only when enabled", async () => {
    let body = await (await creditsRoute()).json();
    expect(body.purchase).toMatchObject({ enabled: true, network: "base-sepolia", chainId: 84532, payTo: PAY_TO, asset: SEPOLIA_USDC });
    expect(body.purchase.packs).toEqual([
      { id: "p1", usd: 1, credits: 1000 },
      { id: "p5", usd: 5, credits: 5000 },
      { id: "p20", usd: 20, credits: 20000 },
    ]);
    delete process.env.PAY_TO_ADDRESS;
    body = await (await creditsRoute()).json();
    expect(body.purchase).toEqual({ enabled: false, network: null, chainId: null, payTo: null, asset: null, packs: [] });
  });
});

describe("POST /api/credits/purchase", () => {
  it("returns 404 when the feature is disabled", async () => {
    delete process.env.PAY_TO_ADDRESS;
    expect((await post({ packId: "p1" })).status).toBe(404);
    expect((await post({ packId: "p1" }, { "PAYMENT-SIGNATURE": "abc" })).status).toBe(404);
    expect(fac.verifyCalls.length + fac.settleCalls.length).toBe(0);
  });

  it("rejects cross-origin, non-JSON and signed-out requests, and unknown packs", async () => {
    expect((await post({ packId: "p1" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ packId: "p1" }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post({ packId: "p99" })).status).toBe(400);
    expect((await post({ packId: "p1", amount: "1", payTo: ATTACKER } as unknown)).status).toBe(402); // extra fields are ignored
    state.userId = null;
    expect((await post({ packId: "p1" })).status).toBe(401);
    expect(await purchases()).toHaveLength(0);
  });

  it("answers a request without a payment header with the x402 challenge", async () => {
    const res = await post({ packId: "p5" });
    expect(res.status).toBe(402);
    expect(await res.clone().json()).toMatchObject({ code: "payment_required" });
    const challenge = wallet.getPaymentRequiredResponse((n) => res.headers.get(n), await res.json());
    expect(challenge.x402Version).toBe(2);
    expect(challenge.accepts).toHaveLength(1);
    expect(challenge.accepts[0]).toMatchObject({ scheme: "exact", network: SEPOLIA, asset: SEPOLIA_USDC, amount: "5000000", payTo: PAY_TO, maxTimeoutSeconds: 300 });
    expect(challenge.accepts[0].extra).toMatchObject({ name: "USDC", version: "2" }); // EIP-712 domain of Sepolia USDC
    expect(fac.verifyCalls.length + fac.settleCalls.length).toBe(0);
    expect(await purchases()).toHaveLength(0);
  });

  it("happy path: verifies, settles and credits exactly once", async () => {
    const res = await post({ packId: "p5" }, await signedHeaders("p5"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ balance: 5100, credits: 5000, txHash: tx(1) });
    expect(res.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
    expect(await getBalance(db, "u1")).toBe(5100);

    // The facilitator was asked about the SERVER's requirements.
    expect(fac.verifyCalls).toHaveLength(1);
    expect(fac.settleCalls).toHaveLength(1);
    expect(fac.settleCalls[0].req).toMatchObject({ amount: "5000000", payTo: PAY_TO, asset: SEPOLIA_USDC, network: SEPOLIA });

    const [row] = await purchases();
    expect(row).toMatchObject({ userId: "u1", packId: "p5", credits: 5000, amountAtomic: "5000000", network: SEPOLIA, status: "settled", txHash: tx(1) });
    expect(row.payer).toBe(account.address.toLowerCase());
    expect(row.payTo).toBe(PAY_TO);
    expect(row.settledAt).toBeInstanceOf(Date);

    const ledger = await listLedger(db, "u1");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ kind: "purchase", delta: 5000, balanceAfter: 5100, ref: tx(1), unmetered: false });
  });

  it("rejects a replayed payment (same nonce) without settling or crediting again", async () => {
    const headers = await signedHeaders("p1");
    expect((await post({ packId: "p1" }, headers)).status).toBe(200);
    const again = await post({ packId: "p1" }, headers);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "payment_replayed" });
    // Another signed-in user can't reuse it either.
    state.userId = "u2";
    expect((await post({ packId: "p1" }, headers)).status).toBe(409);
    expect(fac.settleCalls).toHaveLength(1);
    expect(await getBalance(db, "u1")).toBe(1100);
    expect(await getBalance(db, "u2")).toBe(0);
    expect(await purchases()).toHaveLength(1);
  });

  it("never credits the same transaction hash twice", async () => {
    fac.settleImpl = async () => ({ success: true, transaction: tx(7), network: SEPOLIA });
    expect((await post({ packId: "p1" }, await signedHeaders("p1"))).status).toBe(200);
    const second = await post({ packId: "p1" }, await signedHeaders("p1")); // fresh nonce, same reported tx
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: "payment_not_credited" });
    expect(await getBalance(db, "u1")).toBe(1100);
    expect((await listLedger(db, "u1")).filter((l) => l.kind === "purchase")).toHaveLength(1);
    const rows = await purchases();
    expect(rows.map((r) => r.status).sort()).toEqual(["pending", "settled"]);

    // creditPurchase itself is idempotent and guarded.
    const settled = rows.find((r) => r.status === "settled")!;
    const pending = rows.find((r) => r.status === "pending")!;
    expect(await creditPurchase(db, settled.id, tx(7))).toEqual({ status: "already_credited", balance: 1100 });
    expect(await creditPurchase(db, settled.id, tx(8))).toEqual({ status: "rejected", reason: "bad_status" });
    expect(await creditPurchase(db, pending.id, tx(7))).toEqual({ status: "rejected", reason: "duplicate_tx" });
    expect(await creditPurchase(db, "nope", tx(9))).toEqual({ status: "rejected", reason: "not_found" });
    expect(await getBalance(db, "u1")).toBe(1100);
    // The unique index is the last line of defence against concurrent double credit.
    await expect(db.update(schema.creditPurchases).set({ txHash: tx(7) }).where(eq(schema.creditPurchases.id, pending.id))).rejects.toThrow();
  });

  it("rejects payments that don't match the server-built requirements", async () => {
    const expectRejected = async (res: Response, reason: string) => {
      expect(res.status).toBe(402);
      expect(await res.clone().json()).toMatchObject({ code: "payment_rejected", reason });
      expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy(); // a fresh challenge to retry with
      await db.delete(schema.rateLimits); // many requests in this test; keep it under the 10/min limit
    };
    // Paid for the $1 pack, asks for the $20 pack.
    await expectRejected(await post({ packId: "p20" }, await signedHeaders("p1")), "amount_mismatch");
    // Client claims a smaller amount / other recipient / other token / other network.
    await expectRejected(await post({ packId: "p5" }, await signedHeaders("p5", { challenge: (c) => (c.accepts[0].amount = "1") })), "amount_mismatch");
    await expectRejected(await post({ packId: "p5" }, await signedHeaders("p5", { challenge: (c) => (c.accepts[0].payTo = ATTACKER) })), "pay_to_mismatch");
    await expectRejected(await post({ packId: "p5" }, await signedHeaders("p5", { payload: (p) => (p.accepted.asset = ATTACKER) })), "asset_mismatch");
    await expectRejected(await post({ packId: "p5" }, await signedHeaders("p5", { payload: (p) => (p.accepted.network = "eip155:8453") })), "network_mismatch");
    await expectRejected(await post({ packId: "p5" }, await signedHeaders("p5", { payload: (p) => (p.accepted.scheme = "upto") })), "scheme_mismatch");
    // Honest-looking `accepted`, but the signed authorization itself pays someone else / less / is long-lived.
    const auth = (p: PaymentPayload) => (p.payload as { authorization: Record<string, string> }).authorization;
    await expectRejected(await post({ packId: "p5" }, await signedHeaders("p5", { payload: (p) => (auth(p).to = ATTACKER) })), "pay_to_mismatch");
    await expectRejected(await post({ packId: "p5" }, await signedHeaders("p5", { payload: (p) => (auth(p).value = "1") })), "amount_mismatch");
    await expectRejected(
      await post({ packId: "p5" }, await signedHeaders("p5", { payload: (p) => (auth(p).validBefore = String(Math.floor(Date.now() / 1000) + 86_400)) })),
      "validity_window_too_long",
    );
    await expectRejected(await post({ packId: "p5" }, await signedHeaders("p5", { payload: (p) => (p.payload = { permit2Authorization: {}, signature: "0x" }) })), "unsupported_payload");
    // A v1 payload (the client would send it as legacy X-PAYMENT, which this route ignores) under the v2 header.
    const v1 = await signedHeaders("p5", { payload: (p) => (p.x402Version = 1) });
    await expectRejected(await post({ packId: "p5" }, { "PAYMENT-SIGNATURE": Object.values(v1)[0] }), "unsupported_x402_version");
    await expectRejected(await post({ packId: "p5" }, { "PAYMENT-SIGNATURE": "not-base64-json" }), "malformed_payment_header");

    expect(fac.verifyCalls.length + fac.settleCalls.length).toBe(0);
    expect(await purchases()).toHaveLength(0);
    expect(await getBalance(db, "u1")).toBe(100);
  });

  it("does not settle or credit when verification fails", async () => {
    fac.verifyImpl = async () => ({ isValid: false, invalidReason: "insufficient_funds" });
    const res = await post({ packId: "p1" }, await signedHeaders("p1"));
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: "payment_rejected", reason: "insufficient_funds" });
    expect(fac.settleCalls).toHaveLength(0);
    expect(await purchases()).toHaveLength(0);

    fac.verifyImpl = async () => {
      throw new Error("facilitator down");
    };
    const down = await post({ packId: "p1" }, await signedHeaders("p1"));
    expect(down.status).toBe(502);
    expect(await down.json()).toMatchObject({ code: "facilitator_unavailable" });
    expect(fac.settleCalls).toHaveLength(0);
    expect(await purchases()).toHaveLength(0);
    expect(await getBalance(db, "u1")).toBe(100);
  });

  it("marks the purchase failed and does not credit when settlement fails", async () => {
    fac.settleImpl = async () => ({ success: false, errorReason: "insufficient_funds", transaction: "", network: SEPOLIA });
    const headers = await signedHeaders("p1");
    const res = await post({ packId: "p1" }, headers);
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: "payment_rejected", reason: "insufficient_funds" });
    const [row] = await purchases();
    expect(row).toMatchObject({ status: "failed", txHash: null, settledAt: null });
    expect(await getBalance(db, "u1")).toBe(100);
    expect(await listLedger(db, "u1")).toHaveLength(0);
    // The failed authorization stays burned.
    fac.settleImpl = async () => ({ success: true, transaction: tx(3), network: SEPOLIA });
    expect((await post({ packId: "p1" }, headers)).status).toBe(409);
    expect(await getBalance(db, "u1")).toBe(100);
  });

  it("returns 202 and leaves the purchase pending when the settlement outcome is unknown", async () => {
    const uncertain: (() => Promise<SettleResponse>)[] = [
      async () => ({ success: false, errorReason: "settlement_pending", transaction: tx(4), network: SEPOLIA }),
      async () => {
        throw new Error("timeout");
      },
      async () => ({ success: true, transaction: "", network: SEPOLIA }), // no tx hash
      async () => ({ success: true, transaction: tx(5), network: "eip155:8453" }), // wrong network
    ];
    for (const impl of uncertain) {
      fac.settleImpl = impl;
      const res = await post({ packId: "p1" }, await signedHeaders("p1"));
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ pending: true });
    }
    const rows = await purchases();
    expect(rows).toHaveLength(uncertain.length);
    expect(rows.every((r) => r.status === "pending" && r.txHash === null)).toBe(true);
    expect(await getBalance(db, "u1")).toBe(100);
    expect(await listLedger(db, "u1")).toHaveLength(0);
  });

  it("is rate limited per user", async () => {
    for (let i = 0; i < 10; i++) expect((await post({ packId: "p1" })).status).toBe(402);
    expect((await post({ packId: "p1" })).status).toBe(429);
  });
});

describe("reconcilePurchases", () => {
  const NONCE = (n: number) => `0x${n.toString(16).padStart(64, "a")}`;
  const claim = async (n: number, ageMin: number) => {
    const id = (await claimPending(db, { userId: "u1", packId: "p1", cfg: getPurchaseConfig()!, payer: ATTACKER, nonce: NONCE(n) }))!;
    await db.update(schema.creditPurchases).set({ createdAt: new Date(Date.now() - ageMin * 60_000) }).where(eq(schema.creditPurchases.id, id));
    return id;
  };
  const chain = (over: Partial<ChainReader>): ChainReader => ({
    authorizationUsed: async () => false,
    findAuthorizationTx: async () => null,
    txPaysPurchase: async () => false,
    ...over,
  });
  const statusOf = async (id: string) => (await db.select().from(schema.creditPurchases).where(eq(schema.creditPurchases.id, id)))[0].status;

  it("credits purchases that settled on-chain and fails ones whose authorization expired unused", async () => {
    const paid = await claim(1, 30);
    const unused = await claim(2, 30);
    const fresh = await claim(3, 5.5); // old enough to check, too young to declare dead
    const tooNew = await claim(4, 1);
    const burned = await claim(5, 30); // nonce used, but not by a transfer to us
    const reader = chain({
      authorizationUsed: async (r) => r.id === paid || r.id === burned,
      findAuthorizationTx: async (r) => (r.id === paid ? tx(50) : tx(51)),
      txPaysPurchase: async (r, h) => r.id === paid && h === tx(50),
    });

    const dry = await reconcilePurchases(db, reader, { network: SEPOLIA, dryRun: true });
    expect(dry.find((r) => r.id === paid)?.action).toBe("credited");
    expect(await statusOf(paid)).toBe("pending");
    expect(await getBalance(db, "u1")).toBe(100);

    const res = await reconcilePurchases(db, reader, { network: SEPOLIA });
    const action = (id: string) => res.find((r) => r.id === id)?.action;
    expect(action(paid)).toBe("credited");
    expect(action(unused)).toBe("failed");
    expect(action(fresh)).toBe("waiting");
    expect(action(tooNew)).toBeUndefined();
    expect(action(burned)).toBe("needs_review");
    expect([await statusOf(paid), await statusOf(unused), await statusOf(fresh), await statusOf(tooNew), await statusOf(burned)]).toEqual([
      "settled",
      "failed",
      "pending",
      "pending",
      "pending",
    ]);
    expect(await getBalance(db, "u1")).toBe(1100);
    expect((await listLedger(db, "u1"))[0]).toMatchObject({ kind: "purchase", delta: 1000, ref: tx(50) });

    // Running again changes nothing.
    await reconcilePurchases(db, reader, { network: SEPOLIA, includeFailed: true });
    expect(await getBalance(db, "u1")).toBe(1100);
  });

  it("can rescue a purchase that was marked failed but did land on-chain", async () => {
    const id = await claim(9, 30);
    await db.update(schema.creditPurchases).set({ status: "failed" }).where(eq(schema.creditPurchases.id, id));
    const reader = chain({ authorizationUsed: async () => true, findAuthorizationTx: async () => tx(60), txPaysPurchase: async () => true });
    expect(await reconcilePurchases(db, reader, { network: SEPOLIA })).toHaveLength(0); // failed rows are opt-in
    expect(await reconcilePurchases(db, reader, { network: SEPOLIA, only: { id: "nope", txHash: tx(60) } })).toHaveLength(0);
    const [r] = await reconcilePurchases(db, reader, { network: SEPOLIA, includeFailed: true });
    expect(r).toMatchObject({ action: "credited", txHash: tx(60) });
    expect(await getBalance(db, "u1")).toBe(1100);
  });

  it("checks a named purchase against a given transaction, whatever its age", async () => {
    const id = await claim(10, 0); // just created
    const seen: string[] = [];
    const reader = chain({
      authorizationUsed: async () => true,
      findAuthorizationTx: async () => {
        throw new Error("should not search when --tx is given");
      },
      txPaysPurchase: async (_r, h) => (seen.push(h), h === tx(70)),
    });
    const [bad] = await reconcilePurchases(db, reader, { network: SEPOLIA, only: { id, txHash: tx(71) } });
    expect(bad.action).toBe("needs_review");
    expect(await getBalance(db, "u1")).toBe(100);
    const [ok] = await reconcilePurchases(db, reader, { network: SEPOLIA, only: { id, txHash: tx(70) } });
    expect(ok).toMatchObject({ action: "credited", txHash: tx(70) });
    expect(seen).toEqual([tx(71), tx(70)]);
    expect(await getBalance(db, "u1")).toBe(1100);
    expect(await reconcilePurchases(db, reader, { network: SEPOLIA, only: { id, txHash: tx(70) } })).toHaveLength(0); // already settled
  });
});

describe("payWithWallet (browser client against the real route)", () => {
  /** Minimal injected wallet (EIP-1193) backed by a local key. */
  const makeWallet = (chainId = 1) => {
    const w = {
      chainId,
      signed: [] as { primaryType: string; message: Record<string, string> }[],
      rejectSignature: false,
      async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [account.address];
        if (method === "eth_chainId") return `0x${w.chainId.toString(16)}`;
        if (method === "wallet_switchEthereumChain") {
          w.chainId = Number.parseInt((params![0] as { chainId: string }).chainId, 16);
          return null;
        }
        if (method === "eth_signTypedData_v4") {
          if (w.rejectSignature) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
          const typed = JSON.parse(params![1] as string);
          w.signed.push(typed);
          const types = { ...typed.types };
          delete types.EIP712Domain;
          return account.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message });
        }
        throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
      },
    };
    return w;
  };
  const info = async (): Promise<PurchaseInfo> => (await (await creditsRoute()).json()).purchase;
  const g = globalThis as unknown as { window?: unknown; fetch: typeof fetch };
  const realFetch = g.fetch;

  beforeEach(() => {
    // The browser's same-origin fetch to our API, routed straight into the route handler.
    g.fetch = (async (url: string, init: RequestInit) =>
      purchaseRoute(new Request(`${ORIGIN}${url}`, { ...init, headers: { origin: ORIGIN, ...(init.headers as Record<string, string>) } }))) as unknown as typeof fetch;
  });
  afterEach(() => {
    g.fetch = realFetch;
    delete g.window;
  });

  it("shows a friendly message when no wallet is installed", async () => {
    g.window = {};
    await expect(payWithWallet({ packId: "p1", purchase: await info() })).rejects.toThrow(NO_WALLET_MESSAGE);
    expect(await purchases()).toHaveLength(0);
  });

  it("switches chain, signs the pinned USDC authorization once and gets credited", async () => {
    const w = makeWallet();
    g.window = { ethereum: w };
    const stages: string[] = [];
    const res = await payWithWallet({ packId: "p20", purchase: await info(), onStage: (s) => stages.push(s) });
    expect(res).toEqual({ status: "settled", balance: 20100, credits: 20000, txHash: tx(1) });
    expect(stages).toEqual(["wallet", "quote", "sign", "settle"]);
    expect(w.chainId).toBe(84532);
    expect(w.signed).toHaveLength(1);
    expect(w.signed[0].primaryType).toBe("TransferWithAuthorization");
    expect(w.signed[0].message).toMatchObject({ to: PAY_TO, value: "20000000" });
    expect(await getBalance(db, "u1")).toBe(20100);
  });

  it("reports a cancelled signature as cancelled, with nothing submitted", async () => {
    const w = makeWallet();
    w.rejectSignature = true;
    g.window = { ethereum: w };
    await expect(payWithWallet({ packId: "p1", purchase: await info() })).rejects.toThrow(/Cancelled in the wallet/);
    expect(fac.verifyCalls).toHaveLength(0);
    expect(await purchases()).toHaveLength(0);
  });

  it("refuses to sign when the challenge doesn't match what the app advertised", async () => {
    const w = makeWallet();
    g.window = { ethereum: w };
    const purchase = await info();
    // The server now asks for a different recipient than GET /api/credits said.
    process.env.PAY_TO_ADDRESS = ATTACKER;
    setFacilitatorClient(fac);
    await expect(payWithWallet({ packId: "p1", purchase })).rejects.toThrow(/nothing was signed/);
    // …or a different price for the pack.
    process.env.PAY_TO_ADDRESS = PAY_TO;
    setFacilitatorClient(fac);
    await expect(payWithWallet({ packId: "p1", purchase: { ...purchase, packs: [{ id: "p1", usd: 0.5, credits: 1000 }] } })).rejects.toThrow(/nothing was signed/);
    expect(w.signed).toHaveLength(0);
    expect(fac.verifyCalls).toHaveLength(0);
  });

  it("reports pending (and never re-signs) when settlement is unconfirmed, and surfaces definite rejections", async () => {
    const w = makeWallet(84532);
    g.window = { ethereum: w };
    fac.settleImpl = async () => {
      throw new Error("timeout");
    };
    expect(await payWithWallet({ packId: "p1", purchase: await info() })).toEqual({ status: "pending" });
    expect(w.signed).toHaveLength(1);
    expect(fac.settleCalls).toHaveLength(1);

    fac.verifyImpl = async () => ({ isValid: false, invalidReason: "invalid_exact_evm_insufficient_balance" });
    await expect(payWithWallet({ packId: "p1", purchase: await info() })).rejects.toThrow(/enough USDC/);
    expect(await getBalance(db, "u1")).toBe(100);
  });
});
