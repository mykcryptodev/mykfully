"use client";

import type { ClientEvmSigner } from "@x402/evm";
import type { PurchaseInfo } from "../lib/api";

/**
 * Pay for a credit pack with the browser's injected wallet (MetaMask, Coinbase Wallet, Rabby…) over x402.
 *
 * Loaded only when the user presses "Pay with wallet"; the x402 + viem libraries are imported dynamically
 * inside, so none of this is in the app's initial bundle. It talks to the wallet via `window.ethereum` only
 * (no RPC or third-party host is contacted from the page, so the CSP's `connect-src 'self'` is unchanged).
 *
 * Uses a bare fetch on purpose: `apiFetch` treats 402 as "insufficient credits", but here 402 is the x402 challenge.
 */

export type PayStage = "wallet" | "quote" | "sign" | "settle";

export type PayResult =
  | { status: "settled"; balance: number; credits: number; txHash: string }
  /** The signed payment was sent but its outcome is unknown. Never sign again automatically. */
  | { status: "pending" };

/** A failure with a message that is safe to show. Thrown only when the user was definitely not charged. */
export class WalletPayError extends Error {
  constructor(
    message: string,
    public code: "no_wallet" | "cancelled" | "rejected" | "error" = "error",
  ) {
    super(message);
    this.name = "WalletPayError";
  }
}

export const NO_WALLET_MESSAGE = "Install a wallet like Coinbase Wallet or MetaMask, with USDC on Base";

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

/** Parameters wallets need to add the chain if they don't know it (the page never calls these RPC URLs itself). */
const CHAINS: Record<number, { chainName: string; rpcUrls: string[]; blockExplorerUrls: string[] }> = {
  8453: { chainName: "Base", rpcUrls: ["https://mainnet.base.org"], blockExplorerUrls: ["https://basescan.org"] },
  84532: { chainName: "Base Sepolia", rpcUrls: ["https://sepolia.base.org"], blockExplorerUrls: ["https://sepolia.basescan.org"] },
};

export function explorerTxUrl(chainId: number | null, txHash: string): string | null {
  const base = chainId != null ? CHAINS[chainId]?.blockExplorerUrls[0] : null;
  return base ? `${base}/tx/${txHash}` : null;
}

const REASONS: Record<string, string> = {
  insufficient_funds: "Your wallet doesn’t have enough USDC on this network.",
  invalid_exact_evm_insufficient_balance: "Your wallet doesn’t have enough USDC on this network.",
  invalid_exact_evm_payload_signature: "The wallet’s signature wasn’t accepted. Try again.",
};

const rpcCode = (e: unknown) => (e && typeof e === "object" ? (e as { code?: unknown }).code : undefined);
const isUserRejection = (e: unknown) => rpcCode(e) === 4001 || rpcCode(e) === "ACTION_REJECTED" || /user (rejected|denied)/i.test(String((e as Error)?.message));

async function post(packId: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch("/api/credits/purchase", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ packId }),
  });
}

async function errorFrom(res: Response): Promise<WalletPayError> {
  const data = (await res.json().catch(() => null)) as { error?: string; reason?: string } | null;
  if (res.status === 401) {
    window.location.href = "/login";
    return new WalletPayError("Not signed in");
  }
  if (res.status === 404) return new WalletPayError("Buying credits isn’t available on this instance.");
  if (res.status === 429) return new WalletPayError("Too many attempts. Wait a minute and try again.");
  const friendly = data?.reason ? REASONS[data.reason] : undefined;
  return new WalletPayError(friendly ?? data?.error ?? `Request failed (${res.status})`, "rejected");
}

async function switchChain(eth: Eip1193, chainId: number): Promise<void> {
  const hex = `0x${chainId.toString(16)}`;
  if (String(await eth.request({ method: "eth_chainId" })).toLowerCase() === hex) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if (isUserRejection(e)) throw e;
    // 4902: the wallet doesn't know the chain yet.
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: hex, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, ...CHAINS[chainId] }],
    });
  }
  if (String(await eth.request({ method: "eth_chainId" })).toLowerCase() !== hex) {
    throw new WalletPayError(`Switch your wallet to ${CHAINS[chainId]?.chainName ?? "the right network"} and try again.`);
  }
}

export async function payWithWallet(opts: { packId: string; purchase: PurchaseInfo; onStage?: (s: PayStage) => void }): Promise<PayResult> {
  const { packId, purchase, onStage } = opts;
  const pack = purchase.packs.find((p) => p.id === packId);
  if (!purchase.enabled || !pack || !purchase.chainId || !purchase.payTo || !purchase.asset || !CHAINS[purchase.chainId]) {
    throw new WalletPayError("Buying credits isn’t available on this instance.");
  }
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (!eth?.request) throw new WalletPayError(NO_WALLET_MESSAGE, "no_wallet");

  const network = `eip155:${purchase.chainId}` as const;
  const expectedAmount = String(pack.usd * 1_000_000); // USDC has 6 decimals
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  try {
    // 1. Connect the wallet and put it on Base / Base Sepolia.
    onStage?.("wallet");
    const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
    if (!accounts?.[0]) throw new WalletPayError("No wallet account is connected.");
    await switchChain(eth, purchase.chainId);

    // 2. Ask our server for the x402 challenge (expects 402).
    onStage?.("quote");
    const first = await post(packId);
    if (first.status !== 402) throw await errorFrom(first);

    const [{ x402Client, x402HTTPClient }, { ExactEvmScheme }, { createWalletClient, custom, getAddress }] = await Promise.all([
      import("@x402/core/client"),
      import("@x402/evm/exact/client"),
      import("viem"),
    ]);
    const address = getAddress(accounts[0]);
    const walletClient = createWalletClient({ account: address, transport: custom(eth) });
    const signer: ClientEvmSigner = {
      address,
      signTypedData: (m) => walletClient.signTypedData({ account: address, ...m } as Parameters<typeof walletClient.signTypedData>[0]),
    };
    const client = new x402HTTPClient(
      x402Client.fromConfig({
        // Only this one network is registered, so nothing else can ever be signed for.
        schemes: [{ network, client: new ExactEvmScheme(signer) }],
        // Built-in rail: known USD stablecoins only, at most $20 per payment.
        spendControls: { maxAmountPerPayment: "$20" },
        // Pin the recipient, token, network and exact price to what GET /api/credits told us for this pack.
        policies: [
          (_v, reqs) =>
            reqs.filter(
              (r) =>
                r.scheme === "exact" &&
                r.network === network &&
                same(r.payTo, purchase.payTo!) &&
                same(r.asset, purchase.asset!) &&
                r.amount === expectedAmount,
            ),
        ],
      }),
    );
    const paymentRequired = client.getPaymentRequiredResponse((name) => first.headers.get(name), await first.json().catch(() => undefined));

    // 3. The wallet shows a typed-data signature request (a USDC transfer authorization; no gas needed).
    onStage?.("sign");
    let headers: Record<string, string>;
    try {
      headers = client.encodePaymentSignatureHeader(await client.createPaymentPayload(paymentRequired));
    } catch (e) {
      if (isUserRejection(e)) throw e;
      throw new WalletPayError("The payment request didn’t match this pack, so nothing was signed. Reload and try again.");
    }

    // 4. Send the signed payment. From here on the outcome may be unknown — never sign a second time.
    onStage?.("settle");
    try {
      const paid = await post(packId, headers);
      if (paid.status === 200) {
        const data = (await paid.json()) as { balance: number; credits: number; txHash: string };
        return { status: "settled", balance: data.balance, credits: data.credits, txHash: data.txHash };
      }
      if (paid.status === 502) {
        const data = (await paid.clone().json().catch(() => null)) as { code?: string } | null;
        if (data?.code === "facilitator_unavailable") throw await errorFrom(paid); // failed before anything was submitted
      }
      // 202 (unconfirmed), 409 (already submitted) and 5xx: the payment may have gone through.
      if (paid.status === 202 || paid.status === 409 || paid.status >= 500) return { status: "pending" };
      throw await errorFrom(paid); // 402 and other 4xx are definite rejections: not charged
    } catch (e) {
      if (e instanceof WalletPayError) throw e;
      return { status: "pending" }; // network error / unreadable response: outcome unknown
    }
  } catch (e) {
    if (e instanceof WalletPayError) throw e;
    if (isUserRejection(e)) throw new WalletPayError("Cancelled in the wallet. Nothing was charged.", "cancelled");
    throw new WalletPayError("The wallet couldn’t complete the request. Nothing was charged.");
  }
}
