"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type Draft, type Me } from "../lib/api";

export type ListTab = "draft" | "scheduled" | "published" | "failed";

/** Which sidebar tab a draft belongs to. */
export function tabFor(status: Draft["status"]): ListTab {
  if (status === "publishing") return "scheduled";
  return status;
}

type Toast = { id: number; text: string; tone: "default" | "error" };

type Ctx = {
  me: Me | null;
  setMe: (me: Me) => void;
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
      .then(({ user }) => setMe(user))
      .catch(() => {});
    void refreshDrafts();
  }, [refreshDrafts]);

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
    [me, drafts, draftsLoaded, refreshDrafts, upsertDraft, removeDraft, tab, sidebarOpen, toast],
  );

  return (
    <AppCtx.Provider value={value}>
      {children}
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
