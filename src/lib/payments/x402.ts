import { HTTPFacilitatorClient, x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { PACKS, packAmountAtomic, type PackId, type PurchaseConfig } from "./config";

/**
 * x402 (v2) plumbing for credit purchases: the resource server + facilitator client, server-built
 * PaymentRequirements per pack, and strict validation of the client's signed payment.
 *
 * Nothing the client sends decides what is charged: amount, payTo, asset and network always come from
 * the pack id + env (`PurchaseConfig`), and those server-built requirements — never `payload.accepted` —
 * are what the facilitator verifies and settles against.
 */

/** v2 header carrying the client's signed payment (base64 JSON). */
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
/** v2 header carrying the 402 challenge (base64 JSON `PaymentRequired`). */
export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
/** v2 header carrying the settlement receipt on success. */
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

/** How long a signed authorization stays valid. The reconcile script relies on this being ≤ 5 minutes. */
export const MAX_TIMEOUT_SECONDS = 300;
/** Per-call facilitator timeout; verify + settle must fit in the route's maxDuration (30s). */
const FACILITATOR_TIMEOUT_MS = 12_000;
const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

type State = { override: FacilitatorClient | null; cache: { key: string; server: Promise<x402ResourceServer> } | null };
const g = globalThis as unknown as { __mykX402?: State };
const state: State = (g.__mykX402 ??= { override: null, cache: null });

/** Inject a facilitator (tests) or pass null to go back to the real one. Drops the cached resource server. */
export function setFacilitatorClient(client: FacilitatorClient | null): void {
  state.override = client;
  state.cache = null;
}

/**
 * CDP-hosted facilitator (needed for Base mainnet). Built from the plain HTTP facilitator client plus the
 * a CDP API-key JWT (./cdpJwt, jose-based; same format as the CDP SDK) — one short-lived JWT per endpoint.
 * Loaded only on mainnet.
 */
async function createCdpFacilitator(apiKeyId: string, apiKeySecret: string): Promise<FacilitatorClient> {
  const { generateCdpJwt } = await import("./cdpJwt");
  const { host, pathname } = new URL(CDP_FACILITATOR_URL);
  const auth = async (method: "GET" | "POST", op: string) => ({
    Authorization: `Bearer ${await generateCdpJwt({ apiKeyId, apiKeySecret, requestMethod: method, requestHost: host, requestPath: `${pathname}/${op}` })}`,
  });
  return new HTTPFacilitatorClient({
    url: CDP_FACILITATOR_URL,
    timeoutMs: FACILITATOR_TIMEOUT_MS,
    createAuthHeaders: async () => {
      const [verify, settle, supported] = await Promise.all([auth("POST", "verify"), auth("POST", "settle"), auth("GET", "supported")]);
      return { verify, settle, supported };
    },
  });
}

async function createFacilitator(cfg: PurchaseConfig): Promise<FacilitatorClient> {
  if (state.override) return state.override;
  if (cfg.facilitator.kind === "cdp") return createCdpFacilitator(cfg.facilitator.apiKeyId, cfg.facilitator.apiKeySecret);
  return new HTTPFacilitatorClient({ url: "https://x402.org/facilitator", timeoutMs: FACILITATOR_TIMEOUT_MS });
}

/** Lazily built + initialized resource server (one per config). A failed init is not cached. */
export function getResourceServer(cfg: PurchaseConfig): Promise<x402ResourceServer> {
  const key = [cfg.caip2, cfg.payTo, cfg.facilitator.kind, cfg.facilitator.kind === "cdp" ? cfg.facilitator.apiKeyId : ""].join("|");
  if (state.cache?.key === key) return state.cache.server;
  const server = (async () => {
    const s = new x402ResourceServer(await createFacilitator(cfg)).register(cfg.caip2, new ExactEvmScheme());
    await s.initialize(); // fetches the facilitator's supported kinds
    return s;
  })();
  const entry = { key, server };
  state.cache = entry;
  server.catch(() => {
    if (state.cache === entry) state.cache = null;
  });
  return server;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The one and only payment option for a pack, built server-side. The exact-EVM scheme fills in the asset and
 * its EIP-712 domain (`extra.name`/`extra.version`); we then insist it is the hardcoded USDC and exact amount.
 */
export async function buildPackRequirements(cfg: PurchaseConfig, packId: PackId): Promise<PaymentRequirements> {
  const server = await getResourceServer(cfg);
  const [req] = await server.buildPaymentRequirements({
    scheme: "exact",
    network: cfg.caip2,
    payTo: cfg.payTo,
    price: `$${PACKS[packId].usd}`,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
  });
  if (
    !req ||
    req.scheme !== "exact" ||
    req.network !== cfg.caip2 ||
    !eq(req.asset, cfg.asset) ||
    req.amount !== packAmountAtomic(packId) ||
    !eq(req.payTo, cfg.payTo) ||
    typeof req.extra?.name !== "string" ||
    typeof req.extra?.version !== "string"
  ) {
    throw new Error("x402: built payment requirements do not match the purchase config");
  }
  return req;
}

/** The 402 challenge body/header for a pack (optionally with the reason the previous payment was rejected). */
export async function buildChallenge(cfg: PurchaseConfig, packId: PackId, req: PaymentRequirements, url: string, error?: string): Promise<PaymentRequired> {
  const server = await getResourceServer(cfg);
  const pack = PACKS[packId];
  return server.createPaymentRequiredResponse(
    [req],
    { url, description: `${pack.credits.toLocaleString("en-US")} mykfully credits`, mimeType: "application/json" },
    error,
  );
}

/** The client's payment can't be accepted (malformed, or doesn't match what we asked for). */
export class PaymentRejectedError extends Error {
  constructor(public reason: string) {
    super(reason);
    this.name = "PaymentRejectedError";
  }
}

export type ParsedPayment = {
  payload: PaymentPayload;
  /** Lowercase address that signed the EIP-3009 authorization. */
  payer: string;
  /** Lowercase bytes32 authorization nonce. */
  nonce: string;
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
export const isTxHash = (v: unknown): v is string => typeof v === "string" && BYTES32.test(v);

/**
 * Decode the PAYMENT-SIGNATURE header and check it against the server-built requirements:
 * x402 v2, an EIP-3009 authorization (USDC `transferWithAuthorization`; Permit2 payloads are rejected),
 * accepted option == ours (scheme, network, asset, amount, payTo), and the signed authorization itself pays
 * exactly `amount` to `payTo` within the allowed validity window. Signature/balance checks are the facilitator's job.
 */
export async function parsePayment(cfg: PurchaseConfig, req: PaymentRequirements, header: string): Promise<ParsedPayment> {
  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(header);
  } catch {
    throw new PaymentRejectedError("malformed_payment_header");
  }
  if (!payload || typeof payload !== "object" || payload.x402Version !== 2) throw new PaymentRejectedError("unsupported_x402_version");
  const a = payload.accepted;
  if (!a || typeof a !== "object") throw new PaymentRejectedError("missing_accepted_requirements");
  if (a.scheme !== req.scheme) throw new PaymentRejectedError("scheme_mismatch");
  if (a.network !== req.network) throw new PaymentRejectedError("network_mismatch");
  if (typeof a.asset !== "string" || !eq(a.asset, req.asset)) throw new PaymentRejectedError("asset_mismatch");
  if (a.amount !== req.amount) throw new PaymentRejectedError("amount_mismatch");
  if (typeof a.payTo !== "string" || !eq(a.payTo, req.payTo)) throw new PaymentRejectedError("pay_to_mismatch");
  const server = await getResourceServer(cfg);
  if (!server.findMatchingRequirements([req], payload)) throw new PaymentRejectedError("requirements_mismatch");

  const auth = (payload.payload as { authorization?: Record<string, unknown> } | undefined)?.authorization;
  const sig = (payload.payload as { signature?: unknown } | undefined)?.signature;
  if (!auth || typeof auth !== "object" || typeof sig !== "string") throw new PaymentRejectedError("unsupported_payload");
  const { from, to, value, validBefore, nonce } = auth;
  if (typeof from !== "string" || !ADDRESS.test(from)) throw new PaymentRejectedError("invalid_payer");
  if (typeof nonce !== "string" || !BYTES32.test(nonce)) throw new PaymentRejectedError("invalid_nonce");
  if (typeof to !== "string" || !eq(to, req.payTo)) throw new PaymentRejectedError("pay_to_mismatch");
  if (String(value) !== req.amount) throw new PaymentRejectedError("amount_mismatch");
  const vb = Number(validBefore);
  // Bounded validity: an unused authorization is provably dead soon after, which the reconcile script relies on.
  if (!Number.isFinite(vb) || vb > Date.now() / 1000 + MAX_TIMEOUT_SECONDS + 30) throw new PaymentRejectedError("validity_window_too_long");
  return { payload, payer: from.toLowerCase(), nonce: nonce.toLowerCase() };
}

type FacilitatorFailure = { statusCode?: unknown; invalidReason?: unknown; errorReason?: unknown };

/**
 * Ask the facilitator to verify the payment against OUR requirements.
 * Returns the rejection reason or null when valid; throws when the facilitator can't be reached.
 */
export async function verifyPayment(cfg: PurchaseConfig, req: PaymentRequirements, p: ParsedPayment): Promise<string | null> {
  const server = await getResourceServer(cfg);
  try {
    const res = await server.verifyPayment(p.payload, req);
    if (!res.isValid) return res.invalidReason || "invalid_payment";
    if (res.payer && !eq(res.payer, p.payer)) return "payer_mismatch";
    return null;
  } catch (e) {
    // The facilitator answered non-2xx with a verify body ({ isValid: false, … }) → a definite rejection.
    const f = e as FacilitatorFailure | null;
    if (f && typeof f === "object" && "invalidReason" in f && Number(f.statusCode) < 500) return String(f.invalidReason || "invalid_payment");
    throw e;
  }
}

export type SettleOutcome =
  /** On-chain transfer confirmed by the facilitator on the expected network. Safe to credit. */
  | { kind: "settled"; txHash: string; response: SettleResponse }
  /** The facilitator definitely did not settle. */
  | { kind: "failed"; reason: string }
  /** Unknown: it may still land (timeout, 5xx, `settlement_pending`, odd response). Never credit, never fail. */
  | { kind: "uncertain"; reason: string };

/** Settle against OUR requirements and classify the outcome conservatively. Never throws. */
export async function settlePayment(cfg: PurchaseConfig, req: PaymentRequirements, p: ParsedPayment): Promise<SettleOutcome> {
  let res: SettleResponse;
  try {
    const server = await getResourceServer(cfg);
    res = await server.settlePayment(p.payload, req);
  } catch (e) {
    const f = e as FacilitatorFailure | null;
    const explicit = !!f && typeof f === "object" && "errorReason" in f && Number(f.statusCode) < 500;
    const reason = explicit ? String(f.errorReason || "settle_failed") : "facilitator_error";
    if (explicit && reason !== "settlement_pending") return { kind: "failed", reason };
    console.error("[mykfully] x402 settle outcome unknown:", e instanceof Error ? e.name : "error");
    return { kind: "uncertain", reason };
  }
  if (!res || typeof res !== "object") return { kind: "uncertain", reason: "bad_settle_response" };
  if (!res.success) {
    const reason = res.errorReason || "settle_failed";
    return reason === "settlement_pending" ? { kind: "uncertain", reason } : { kind: "failed", reason };
  }
  if (res.network !== cfg.caip2) return { kind: "uncertain", reason: "unexpected_network" };
  if (!isTxHash(res.transaction)) return { kind: "uncertain", reason: "missing_transaction" };
  if (res.payer && !eq(res.payer, p.payer)) return { kind: "uncertain", reason: "payer_mismatch" };
  return { kind: "settled", txHash: res.transaction.toLowerCase(), response: res };
}
