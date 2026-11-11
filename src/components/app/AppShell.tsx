"use client";

import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { AppProvider, useApp } from "./AppProvider";
import { Sidebar } from "../sidebar/Sidebar";
import { Composer } from "../composer/Composer";
import { IconAlert } from "../ui/icons";

/**
 * The composer lives in the layout (not the page) so it isn't remounted when the
 * URL changes from "/" to "/drafts/:id" after the first autosave. Full-page routes
 * (e.g. /admin) render their page instead; the composer stays mounted but hidden so
 * unsaved edits survive the round-trip.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const fullPage = pathname === "/admin" || pathname.startsWith("/admin/");
  const m = pathname.match(/^\/drafts\/([^/]+)/);
  const routeId = m ? decodeURIComponent(m[1]) : null;
  // Keep the composer on its last draft while a full page is shown (derived state, updated during render).
  const [lastRouteId, setLastRouteId] = useState<string | null>(routeId);
  if (!fullPage && routeId !== lastRouteId) setLastRouteId(routeId);
  return (
    <AppProvider>
      <div className="flex h-dvh flex-col overflow-hidden bg-canvas text-ink">
        <ReconnectBanner />
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <main className={`min-w-0 flex-1 ${fullPage ? "hidden" : "flex"}`}>
            <Composer routeId={fullPage ? lastRouteId : routeId} />
          </main>
          {fullPage ? <main className="flex min-w-0 flex-1 flex-col">{children}</main> : children}
        </div>
      </div>
    </AppProvider>
  );
}

function ReconnectBanner() {
  const { me } = useApp();
  if (!me?.needsReconnect) return null;
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center justify-center gap-2 border-b border-warn/50 bg-warn/20 px-4 py-1.5 text-[13px] text-ink"
    >
      <IconAlert size={15} className="shrink-0" />
      <span>Your X connection expired — scheduled posts are paused.</span>
      <a
        href="/api/auth/login"
        className="shrink-0 rounded-full bg-ink px-3 py-0.5 text-[12.5px] font-bold text-canvas transition-opacity hover:opacity-90"
      >
        Reconnect X
      </a>
    </div>
  );
}
