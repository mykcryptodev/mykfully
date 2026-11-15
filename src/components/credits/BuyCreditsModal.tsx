"use client";

import { useEffect, useState } from "react";
import { formatCredits, type PurchaseInfo } from "../lib/api";
import { IconAlert, IconCheckCircle, IconClock, IconExternal } from "../ui/icons";
import { Modal } from "../ui/Modal";
import { Spinner } from "../ui/Spinner";
import type { ConnectedWallet, WalletKind } from "./payWithWallet";

/**
 * Buy a credit pack with USDC (x402). Loaded with next/dynamic only when opened; the wallet code
 * (payWithWallet → Coinbase Wallet SDK, x402, viem) is preloaded when it opens.
 *
 * Coinbase Wallet takes two clicks: "Connect" opens the sign-in popup, then "Pay" opens the signature popup.
 * Each popup gets its own click because browsers block a second popup opened without one. An injected
 * (extension) wallet doesn't need popups, so it connects and pays in one click.
 */

type Phase =
  | { name: "pick"; error?: string }
  | { name: "busy"; stage: string; kind: WalletKind }
  | { name: "done"; credits: number; txUrl: string | null }
  | { name: "pending" };

const STAGE_TEXT: Record<string, string> = {
  wallet: "Connecting to your wallet…",
  quote: "Preparing the payment…",
  sign: "Confirm the payment in your wallet…",
  settle: "Settling on-chain…",
};

export function BuyCreditsModal({ purchase, onClose, onPurchased }: { purchase: PurchaseInfo; onClose: () => void; onPurchased: () => void }) {
  const [packId, setPackId] = useState(purchase.packs[Math.min(1, purchase.packs.length - 1)]?.id ?? "");
  const [phase, setPhase] = useState<Phase>({ name: "pick" });
  /** The connected Coinbase Wallet, once the user has signed in through its popup. */
  const [coinbase, setCoinbase] = useState<ConnectedWallet | null>(null);
  const [hasInjected, setHasInjected] = useState(false);
  const busy = phase.name === "busy";
  const testnet = purchase.network !== "base";
  const networkName = testnet ? "Base Sepolia (testnet)" : "Base";
  const pack = purchase.packs.find((p) => p.id === packId);

  useEffect(() => {
    void import("./payWithWallet").then((m) => {
      m.preloadWallet(purchase.chainId);
      setHasInjected(m.hasInjectedWallet());
    });
  }, [purchase.chainId]);

  const fail = (e: unknown) =>
    setPhase({ name: "pick", error: e instanceof Error && e.name === "WalletPayError" ? e.message : "Something went wrong. Nothing was charged." });

  const connectCoinbase = async () => {
    if (busy) return;
    setPhase({ name: "busy", stage: "Sign in to Coinbase Wallet in the popup…", kind: "coinbase" });
    try {
      const { connectWallet } = await import("./payWithWallet");
      setCoinbase(await connectWallet("coinbase", purchase));
      setPhase({ name: "pick" });
    } catch (e) {
      fail(e);
    }
  };

  const pay = async (kind: WalletKind) => {
    if (busy) return;
    setPhase({ name: "busy", stage: STAGE_TEXT.wallet, kind });
    try {
      const { connectWallet, payWithWallet, explorerTxUrl } = await import("./payWithWallet");
      const wallet = kind === "coinbase" && coinbase ? coinbase : await connectWallet(kind, purchase);
      const res = await payWithWallet({ packId, purchase, wallet, onStage: (s) => setPhase({ name: "busy", stage: STAGE_TEXT[s], kind }) });
      if (res.status === "settled") setPhase({ name: "done", credits: res.credits, txUrl: explorerTxUrl(purchase.chainId, res.txHash) });
      else setPhase({ name: "pending" });
      onPurchased();
    } catch (e) {
      fail(e);
    }
  };

  const spinner = (kind: WalletKind, label: string) =>
    busy && phase.kind === kind ? (
      <>
        <Spinner size={16} /> {phase.stage}
      </>
    ) : (
      label
    );

  return (
    <Modal open onClose={busy ? () => {} : onClose} labelledBy="buy-credits-title" className="max-w-[380px] p-6">
      <h2 id="buy-credits-title" className="text-xl font-bold leading-6 text-ink">
        Buy credits
      </h2>

      {phase.name === "done" ? (
        <div className="mt-4">
          <div className="flex items-center gap-2 text-[15px] font-bold text-success">
            <IconCheckCircle size={20} /> {formatCredits(phase.credits)} credits added
          </div>
          {phase.txUrl && (
            <a href={phase.txUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[13px] font-semibold text-accent hover:underline">
              View transaction <IconExternal size={13} />
            </a>
          )}
          <button data-autofocus onClick={onClose} className="mt-6 h-11 w-full rounded-full bg-ink text-[15px] font-bold text-canvas hover:opacity-90">
            Done
          </button>
        </div>
      ) : phase.name === "pending" ? (
        <div className="mt-4">
          <div className="flex items-start gap-2 text-[14px] leading-5 text-ink">
            <IconClock size={18} className="mt-px shrink-0 text-accent" />
            <span>
              Your payment was submitted but isn’t confirmed yet. <b>Don’t pay again.</b> Your credits are added once it confirms; if they
              haven’t arrived in a few minutes, contact the admin of this instance.
            </span>
          </div>
          <button data-autofocus onClick={onClose} className="mt-6 h-11 w-full rounded-full bg-ink text-[15px] font-bold text-canvas hover:opacity-90">
            Close
          </button>
        </div>
      ) : (
        <>
          <p className="mt-1 text-[14px] leading-5 text-muted">
            Pay with USDC on {networkName}. 1,000 credits = $1 of X API usage. Purchases are final.
          </p>
          <div role="radiogroup" aria-label="Credit pack" className="mt-4 flex flex-col gap-2">
            {purchase.packs.map((p) => {
              const on = p.id === packId;
              return (
                <button
                  key={p.id}
                  role="radio"
                  aria-checked={on}
                  disabled={busy}
                  onClick={() => setPackId(p.id)}
                  className={`flex h-12 items-center justify-between rounded-xl border px-4 text-[15px] transition-colors disabled:opacity-60 ${
                    on ? "border-accent bg-accent-soft text-ink" : "border-line-strong text-ink hover:bg-hover"
                  }`}
                >
                  <span>
                    <b className="tabular-nums">{formatCredits(p.credits)}</b> credits
                  </span>
                  <span className="font-bold tabular-nums">${p.usd} USDC</span>
                </button>
              );
            })}
          </div>
          {phase.name === "pick" && phase.error && (
            <p role="alert" className="mt-3 flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
              <IconAlert size={16} className="mt-0.5 shrink-0" />
              <span>{phase.error}</span>
            </p>
          )}
          <div className="mt-5 flex flex-col gap-3">
            <button
              data-autofocus
              disabled={busy || !packId}
              onClick={coinbase ? () => pay("coinbase") : connectCoinbase}
              className="flex h-11 items-center justify-center gap-2 rounded-full bg-accent text-[15px] font-bold text-white transition-colors hover:bg-accent-hover disabled:opacity-70"
            >
              {spinner("coinbase", coinbase ? `Pay $${pack?.usd ?? ""} with Coinbase Wallet` : "Connect Coinbase Wallet")}
            </button>
            {coinbase && !busy && (
              <p className="-mt-1 text-center text-[12px] leading-4 text-faint">
                Connected {coinbase.address.slice(0, 6)}…{coinbase.address.slice(-4)}
              </p>
            )}
            {hasInjected && (
              <button
                disabled={busy || !packId}
                onClick={() => pay("injected")}
                className="flex h-11 items-center justify-center gap-2 rounded-full border border-line-strong text-[15px] font-bold text-ink transition-colors hover:bg-hover disabled:opacity-60"
              >
                {spinner("injected", "Pay with browser wallet")}
              </button>
            )}
            <button
              disabled={busy}
              onClick={onClose}
              className="h-11 rounded-full border border-line-strong text-[15px] font-bold text-ink transition-colors hover:bg-hover disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
          <p className="mt-3 text-[12px] leading-4 text-faint">
            You’ll sign a USDC transfer authorization — no gas needed. Coinbase Wallet opens in a popup and signs in with a passkey, so
            there’s nothing to install. Browser wallets such as MetaMask or Rabby work too.
          </p>
        </>
      )}
    </Modal>
  );
}
