"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AppProvider } from "./AppProvider";
import { Sidebar } from "../sidebar/Sidebar";
import { Composer } from "../composer/Composer";

/**
 * The composer lives in the layout (not the page) so it isn't remounted when the
 * URL changes from "/" to "/drafts/:id" after the first autosave.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const m = pathname.match(/^\/drafts\/([^/]+)/);
  const routeId = m ? decodeURIComponent(m[1]) : null;
  return (
    <AppProvider>
      <div className="flex h-dvh overflow-hidden bg-canvas text-ink">
        <Sidebar />
        <main className="flex min-w-0 flex-1">
          <Composer routeId={routeId} />
        </main>
        {children}
      </div>
    </AppProvider>
  );
}
