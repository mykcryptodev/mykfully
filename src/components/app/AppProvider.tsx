"use client";

import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type CreditsInfo, type Draft, type Me } from "../lib/api";
import { browserTimezone } from "../lib/time";

export type ListTab = "draft" | "scheduled" | "published" | "failed";

/** Which sidebar tab a draft belongs to. */
export function tabFor(status: Draft["status"]): ListTab {
  if (status === "publishing") return "scheduled";
  return status;
}

// Optional "buy credits" dialog: its chunk is fetched only when it is first opened (and never if purchases are off).
const BuyCreditsModal = dynamic(() => import("../credits/BuyCreditsModal").then((m) => m.BuyCreditsModal), { ssr: false });

type Toast = { id: number; text: string; tone: "default" | "error" };

type Ctx = {
  me: Me | null;
  setMe: (me: Me) => void;
  /** Re-fetch /api/me and /api/credits (after publish, schedule, admin grants…). */
  refreshMe: () => Promise<void>;
  /** Balance, costs and recent ledger from /api/credits (null until loaded). */
  credits: CreditsInfo | null;
  /** Opens the "Buy credits" dialog; null unless this instance sells credits (credits.purchase.enabled). */
  buyCredits: (() => void) | null;
  drafts: Draft[];
  draftsLoaded: boolean;
  refreshDrafts: () => Promise<void>;
  upsertDraft: (d: Draft) => void;
  removeDraft: (id: string) => void;
  tab: ListTab;
  setTab: (t: ListTab) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (o: boolean) => void;
  toast: (text: string, tone?: Toast["tone"]) => void;
};

const AppCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp outside AppProvider");
  return c;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [draftsLoaded, setDraftsLoaded] = useState(false);
  const [tab, setTab] = useState<ListTab>("draft");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const [credits, setCredits] = useState<CreditsInfo | null>(null);

  const [buyOpen, setBuyOpen] = useState(false);
  const purchase = credits?.purchase?.enabled ? credits.purchase : null;
  const canBuy = !!purchase;
  const buyCredits = useMemo(() => (canBuy ? () => setBuyOpen(true) : null), [canBuy]);

  const refreshCredits = useCallback(async () => {
    try {
      setCredits(await api.getCredits());
    } catch {
      /* endpoint unavailable or 401 (handled by apiFetch) */
    }
  }, []);

  const refreshMe = useCallback(async () => {
    await Promise.all([
      api
        .me()
        .then(({ user }) => setMe(user))
        .catch(() => {}),
      refreshCredits(),
    ]);
  }, [refreshCredits]);

  // Keep the balance fresh when the user comes back to the tab (the scheduler may have spent credits).
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") void refreshMe();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refreshMe]);

  const refreshDrafts = useCallback(async () => {
    try {
      const { drafts } = await api.listDrafts();
      setDrafts(drafts);
      setDraftsLoaded(true);
    } catch {
      /* 401 handled by apiFetch */
    }
  }, []);

  useEffect(() => {
    api
      .me()
      .then(async ({ user }) => {
        setMe(user);
        // First run: adopt the browser's timezone instead of the UTC default (once per browser).
        let adopted = false;
        try {
          adopted = localStorage.getItem("myk_tz_adopted") === "1";
        } catch {}
        const browserTz = browserTimezone();
        if (!adopted && user.timezone === "UTC" && browserTz !== "UTC") {
          try {
            const res = await api.setTimezone(browserTz);
            setMe(res.user);
          } catch {}
        }
        try {
          localStorage.setItem("myk_tz_adopted", "1");
        } catch {}
      })
      .catch(() => {});
    void refreshDrafts();
    void refreshCredits();
  }, [refreshDrafts, refreshCredits]);

  const upsertDraft = useCallback((d: Draft) => {
    setDrafts((list) => {
      const rest = list.filter((x) => x.id !== d.id);
      return [d, ...rest];
    });
  }, []);
  const removeDraft = useCallback((id: string) => setDrafts((list) => list.filter((x) => x.id !== id)), []);

  const toast = useCallback((text: string, tone: Toast["tone"] = "default") => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  const value = useMemo(
    () => ({
      me,
      setMe,
      refreshMe,
      credits,
      buyCredits,
      drafts,
      draftsLoaded,
      refreshDrafts,
      upsertDraft,
      removeDraft,
      tab,
      setTab,
      sidebarOpen,
      setSidebarOpen,
      toast,
    }),
    [me, refreshMe, credits, buyCredits, drafts, draftsLoaded, refreshDrafts, upsertDraft, removeDraft, tab, sidebarOpen, toast],
  );

  return (
    <AppCtx.Provider value={value}>
      {children}
      {buyOpen && purchase && <BuyCreditsModal purchase={purchase} onClose={() => setBuyOpen(false)} onPurchased={() => void refreshMe()} />}
      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`animate-pop pointer-events-auto rounded-md px-4 py-3 text-[15px] text-white shadow-pop ${
              t.tone === "error" ? "bg-danger" : "bg-accent"
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </AppCtx.Provider>
  );
}
