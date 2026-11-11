"use client";

import { useEffect, useRef, useState } from "react";
import { creditsToUsd, formatCredits } from "../lib/api";
import { useApp } from "../app/AppProvider";
import { IconCoin, IconX } from "../ui/icons";
import { Spinner } from "../ui/Spinner";
import { LedgerList } from "./LedgerList";

/** Max credits a mention search can cost (one paid user lookup page ≈ 8 users × userRead). */
const MENTION_SEARCH_MAX_USERS = 8;

export function CreditsChip() {
  const { me, credits, refreshMe, buyCredits } = useApp();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!me) return null;
  const isAdmin = credits?.isAdmin ?? me.isAdmin;
  const balance = credits?.balance ?? me.credits;
  const costs = credits?.costs ?? { post: 15, postWithUrl: 200, userRead: 10 };
  const low = !isAdmin && balance < costs.post;

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) {
      setLoading(true);
      await refreshMe();
      setLoading(false);
    }
  };

  return (
    <div ref={ref} className="relative mb-2">
      <button
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`flex h-9 w-full items-center gap-2 rounded-full border px-3 text-[13px] transition-colors hover:bg-hover ${
          low ? "border-danger/40 text-danger" : "border-line-strong text-ink"
        }`}
        title="Credits and history"
      >
        <IconCoin size={16} className={low ? "text-danger" : "text-accent"} />
        {isAdmin ? (
          <>
            <span className="font-bold">Unlimited</span>
            <span className="rounded-full bg-accent-soft px-1.5 py-px text-[11px] font-bold text-accent">Admin</span>
          </>
        ) : (
          <span className="min-w-0 truncate">
            <b className="tabular-nums">{formatCredits(balance)}</b> credits
            <span className="text-muted"> · {creditsToUsd(balance)}</span>
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Credits"
          className="animate-pop absolute bottom-full left-0 z-50 mb-2 w-[320px] max-w-[calc(100vw-24px)] rounded-2xl bg-canvas p-4 shadow-pop"
        >
          <div className="flex items-start justify-between">
            <div>
              <div className="text-[13px] text-muted">Balance</div>
              <div className="text-[26px] font-extrabold leading-8 tracking-tight tabular-nums text-ink">
                {isAdmin ? "Unlimited" : formatCredits(balance)}
              </div>
              <div className="text-[13px] text-muted">
                {isAdmin ? "Admin spend is logged but not deducted" : `${creditsToUsd(balance)} of X API usage`}
              </div>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="rounded-full p-1.5 text-muted hover:bg-hover"
              aria-label="Close credits"
            >
              <IconX size={16} />
            </button>
          </div>

          <div className="mt-3 rounded-xl bg-hover px-3 py-2 text-[12.5px] leading-5 text-muted">
            Post: <b className="text-ink">{costs.post}</b> · Post with link: <b className="text-ink">{costs.postWithUrl}</b> ·
            Mention search: up to <b className="text-ink">{costs.userRead * MENTION_SEARCH_MAX_USERS}</b>
          </div>

          <div className="mt-3 flex items-center justify-between">
            <span className="text-[14px] font-bold text-ink">Recent activity</span>
            {loading && (
              <span className="text-accent">
                <Spinner size={14} />
              </span>
            )}
          </div>
          <div className="mt-1 max-h-[280px] overflow-y-auto">
            {credits ? (
              <LedgerList ledger={credits.ledger} tz={me.timezone} />
            ) : (
              !loading && <p className="py-4 text-center text-[13px] text-muted">History unavailable.</p>
            )}
          </div>
          {!isAdmin && buyCredits && (
            <button
              onClick={() => {
                setOpen(false);
                buyCredits();
              }}
              className="mt-3 h-9 w-full rounded-full bg-accent text-[14px] font-bold text-white transition-colors hover:bg-accent-hover"
            >
              Buy credits
            </button>
          )}
          {!isAdmin && (
            <p className="mt-2 text-[12px] text-faint">
              {buyCredits ? "Pay with USDC, or ask the admin of this instance." : "Need more? Ask the admin of this instance."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
