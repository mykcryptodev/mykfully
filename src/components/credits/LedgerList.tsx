"use client";

import type { CreditKind, LedgerEntry } from "../lib/api";
import { formatCredits } from "../lib/api";
import { relativeShort } from "../lib/time";
import { IconGift, IconMinus, IconPlus, IconSend, IconUndo } from "../ui/icons";

const KIND: Record<CreditKind, { label: string; Icon: typeof IconPlus; cls: string }> = {
  signup: { label: "Welcome", Icon: IconGift, cls: "bg-accent-soft text-accent" },
  grant: { label: "Grant", Icon: IconPlus, cls: "bg-success/12 text-success" },
  revoke: { label: "Revoke", Icon: IconMinus, cls: "bg-danger/10 text-danger" },
  spend: { label: "Spend", Icon: IconSend, cls: "bg-hover text-muted" },
  refund: { label: "Refund", Icon: IconUndo, cls: "bg-success/12 text-success" },
};

function describe(e: LedgerEntry): string {
  if (e.reason) return e.reason;
  if (e.ref) return e.ref;
  return KIND[e.kind]?.label ?? e.kind;
}

/** Compact credit history rows: kind icon, description, signed delta, relative time. */
export function LedgerList({ ledger, tz, empty = "No activity yet." }: { ledger: LedgerEntry[]; tz: string; empty?: string }) {
  if (ledger.length === 0) return <p className="px-1 py-4 text-center text-[13px] text-muted">{empty}</p>;
  return (
    <ul className="flex flex-col">
      {ledger.map((e) => {
        const k = KIND[e.kind] ?? KIND.spend;
        const positive = e.delta > 0;
        return (
          <li key={e.id} className="flex items-center gap-2.5 py-2">
            <span className={`flex size-7 shrink-0 items-center justify-center rounded-full ${k.cls}`} title={k.label}>
              <k.Icon size={14} strokeWidth={2.2} />
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-[13.5px] text-ink" title={describe(e)}>
                {describe(e)}
              </div>
              <div className="flex items-center gap-1 text-[12px] text-muted">
                <span>{k.label}</span>
                <span aria-hidden>·</span>
                <span>{relativeShort(e.createdAt, tz)}</span>
                {e.unmetered && (
                  <span className="ml-0.5 rounded-full bg-hover px-1.5 text-[11px] font-semibold" title="Admin spend isn't deducted">
                    unmetered
                  </span>
                )}
              </div>
            </div>
            <span
              className={`shrink-0 text-[13.5px] font-bold tabular-nums ${
                e.unmetered ? "text-muted" : positive ? "text-success" : "text-ink"
              }`}
            >
              {positive ? "+" : e.delta < 0 ? "−" : ""}
              {formatCredits(Math.abs(e.delta))}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
