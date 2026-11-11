import { getAddress, isAddress, zeroAddress } from "viem";
import { env } from "../env";

/**
 * Optional feature: users buy mykfully credits with USDC on Base through the x402 payment protocol.
 * (X itself doesn't speak x402 — this sells the instance's OWN credits; posting is unchanged.)
 * Entirely off unless PAY_TO_ADDRESS + X402_NETWORK (+ CDP keys on mainnet) are configured.
 */

/** Credit packs. 1 credit ≈ $0.001, so $1 = 1,000 credits. Prices are whole USD. */
export const PACKS = {
  p1: { usd: 1, credits: 1_000 },
  p5: { usd: 5, credits: 5_000 },
  p20: { usd: 20, credits: 20_000 },
} as const;
export type PackId = keyof typeof PACKS;

export function isPackId(id: unknown): id is PackId {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(PACKS, id);
}

export const USDC_DECIMALS = 6;

/** Pack price in USDC atomic units (6 decimals), e.g. p5 → "5000000". */
export function packAmountAtomic(id: PackId): string {
  return String(PACKS[id].usd * 10 ** USDC_DECIMALS); // whole-USD packs: exact in a double
}

/**
 * Supported networks with Circle's native USDC contract hardcoded (never taken from env or the client).
 * Addresses match @x402/evm's DEFAULT_ASSETS and Circle's docs (developers.circle.com/stablecoins/usdc-contract-addresses).
 */
export const X402_NETWORKS = {
  base: { caip2: "eip155:8453", chainId: 8453, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  "base-sepolia": { caip2: "eip155:84532", chainId: 84532, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
} as const;
export type X402NetworkName = keyof typeof X402_NETWORKS;
export type Caip2 = (typeof X402_NETWORKS)[X402NetworkName]["caip2"];

export type PurchaseConfig = {
  network: X402NetworkName;
  caip2: Caip2;
  chainId: number;
  /** USDC contract (checksummed). */
  asset: `0x${string}`;
  /** Recipient of the USDC (checksummed). */
  payTo: `0x${string}`;
  facilitator: { kind: "x402.org" } | { kind: "cdp"; apiKeyId: string; apiKeySecret: string };
};

/**
 * The validated purchase configuration, or null when the feature is off:
 * - PAY_TO_ADDRESS must be a valid, non-zero 0x address (a mixed-case address must pass its EIP-55 checksum,
 *   so a typo disables the feature instead of sending money to the wrong place);
 * - X402_NETWORK must be "base" or "base-sepolia";
 * - "base" also needs CDP_API_KEY_ID + CDP_API_KEY_SECRET (the CDP facilitator); base-sepolia uses x402.org.
 */
export function getPurchaseConfig(): PurchaseConfig | null {
  const name = env.x402Network;
  if (name !== "base" && name !== "base-sepolia") return null;
  const rawPayTo = env.payToAddress;
  if (!isAddress(rawPayTo) || rawPayTo.toLowerCase() === zeroAddress) return null;
  const net = X402_NETWORKS[name];
  let facilitator: PurchaseConfig["facilitator"] = { kind: "x402.org" };
  if (name === "base") {
    const apiKeyId = env.cdpApiKeyId;
    const apiKeySecret = env.cdpApiKeySecret;
    if (!apiKeyId || !apiKeySecret) return null;
    facilitator = { kind: "cdp", apiKeyId, apiKeySecret };
  }
  return { network: name, caip2: net.caip2, chainId: net.chainId, asset: net.usdc, payTo: getAddress(rawPayTo), facilitator };
}

export type PublicPurchaseInfo = {
  enabled: boolean;
  network: X402NetworkName | null;
  chainId: number | null;
  /** Where payments go and in which token, so the client can pin them before signing. */
  payTo: string | null;
  asset: string | null;
  packs: { id: PackId; usd: number; credits: number }[];
};

/** What GET /api/credits exposes (no secrets). */
export function publicPurchaseInfo(): PublicPurchaseInfo {
  const cfg = getPurchaseConfig();
  if (!cfg) return { enabled: false, network: null, chainId: null, payTo: null, asset: null, packs: [] };
  return {
    enabled: true,
    network: cfg.network,
    chainId: cfg.chainId,
    payTo: cfg.payTo,
    asset: cfg.asset,
    packs: (Object.keys(PACKS) as PackId[]).map((id) => ({ id, usd: PACKS[id].usd, credits: PACKS[id].credits })),
  };
}
