"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, creditsToUsd, formatCredits, type AdminUser, type LedgerEntry } from "../lib/api";
import { relativeShort } from "../lib/time";
import { useApp } from "../app/AppProvider";
import { Avatar } from "../ui/Avatar";
import { Modal } from "../ui/Modal";
import { Spinner } from "../ui/Spinner";
import { IconChevronDown, IconMenu, IconSearch } from "../ui/icons";
import { LedgerList } from "../credits/LedgerList";

type LoadState = "loading" | "ready" | "notfound" | "error";

export function AdminPage() {
  const { me, toast, refreshMe, setSidebarOpen } = useApp();
  const tz = me?.timezone ?? "UTC";
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [ledgers, setLedgers] = useState<Record<string, LedgerEntry[] | "loading" | "error">>({});
  const [grantFor, setGrantFor] = useState<AdminUser | null>(null);

  const load = useCallback(async () => {
    try {
      const { users } = await api.adminUsers();
      setUsers(users);
      setState("ready");
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 403)) setState("notfound");
      else {
        setError(e instanceof Error ? e.message : "Couldn’t load users");
        setState("error");
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadLedger = useCallback(async (id: string) => {
    setLedgers((l) => ({ ...l, [id]: "loading" }));
    try {
      const { ledger } = await api.adminLedger(id);
      setLedgers((l) => ({ ...l, [id]: ledger }));
    } catch {
      setLedgers((l) => ({ ...l, [id]: "error" }));
    }
  }, []);

  const toggle = (id: string) => {
    const next = expanded === id ? null : id;
    setExpanded(next);
    if (next && !Array.isArray(ledgers[next])) void loadLedger(next);
  };

  const filtered = useMemo(() => {
    const lq = q.trim().replace(/^@/, "").toLowerCase();
    if (!lq) return users;
    return users.filter((u) => u.username.toLowerCase().includes(lq) || u.name.toLowerCase().includes(lq));
  }, [users, q]);

  const totals = useMemo(
    () => ({
      balance: users.filter((u) => !u.isAdmin).reduce((s, u) => s + u.credits, 0),
      spent7d: users.reduce((s, u) => s + u.spent7d, 0),
      spent30d: users.reduce((s, u) => s + u.spent30d, 0),
    }),
    [users],
  );

  const onGranted = async (u: AdminUser, balance: number) => {
    toast(`@${u.username} now has ${formatCredits(balance)} credits`);
    setGrantFor(null);
    setUsers((list) => list.map((x) => (x.id === u.id ? { ...x, credits: balance } : x)));
    await Promise.all([load(), refreshMe(), expanded === u.id || ledgers[u.id] ? loadLedger(u.id) : null]);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="sticky top-0 z-20 flex h-[53px] shrink-0 items-center gap-2 border-b border-line bg-canvas/85 px-3 backdrop-blur-md sm:px-4">
        <button
          className="rounded-full p-2 text-ink hover:bg-hover md:hidden"
          onClick={() => setSidebarOpen(true)}
          aria-label="Open menu"
        >
          <IconMenu size={20} />
        </button>
        <h1 className="text-[20px] font-bold leading-6 text-ink">Admin</h1>
        <span className="flex-1" />
        {state === "ready" && (
          <span className="hidden text-[13px] text-muted sm:inline">
            {users.length} user{users.length === 1 ? "" : "s"}
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {state === "loading" && (
          <div className="flex justify-center py-20 text-accent">
            <Spinner size={26} />
          </div>
        )}
        {state === "notfound" && (
          <div className="px-6 py-20 text-center">
            <p className="text-xl font-bold">Not found</p>
            <p className="mt-1 text-muted">This page doesn’t exist.</p>
          </div>
        )}
        {state === "error" && (
          <div className="px-6 py-20 text-center">
            <p className="text-xl font-bold">Something went wrong</p>
            <p className="mt-1 text-muted">{error}</p>
            <button onClick={() => void load()} className="mt-5 h-9 rounded-full bg-ink px-4 font-bold text-canvas">
              Retry
            </button>
          </div>
        )}
        {state === "ready" && (
          <div className="mx-auto w-full max-w-[1000px] px-4 pb-24 pt-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Stat label="Outstanding balance" value={totals.balance} hint="non-admin users" />
              <Stat label="Spent · 7 days" value={totals.spent7d} />
              <Stat label="Spent · 30 days" value={totals.spent30d} />
            </div>

            <label className="mt-4 flex h-11 items-center gap-2 rounded-full border border-line-strong px-4 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
              <IconSearch size={17} className="text-muted" />
              <span className="sr-only">Search by handle</span>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search by @handle"
                className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-muted"
              />
            </label>

            <div className="mt-4 overflow-x-auto rounded-2xl border border-line">
              <table className="w-full min-w-[720px] text-left text-[14px]">
                <thead className="border-b border-line text-[12.5px] text-muted">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">User</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Balance</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Spent 7d</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Spent 30d</th>
                    <th className="px-3 py-2.5 font-semibold">Last seen</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((u) => {
                    const open = expanded === u.id;
                    const ledger = ledgers[u.id];
                    return (
                      <Fragment key={u.id}>
                        <tr
                          className={`cursor-pointer border-b border-line transition-colors last:border-b-0 hover:bg-hover ${open ? "bg-hover" : ""}`}
                          onClick={() => toggle(u.id)}
                          aria-expanded={open}
                        >
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <IconChevronDown
                                size={14}
                                className={`shrink-0 text-muted transition-transform ${open ? "" : "-rotate-90"}`}
                              />
                              <Avatar src={u.profileImageUrl} name={u.name} size={36} />
                              <div className="min-w-0 leading-tight">
                                <div className="flex items-center gap-1.5">
                                  <span className="truncate font-bold text-ink">{u.name}</span>
                                  {u.isAdmin && (
                                    <span className="rounded-full bg-accent-soft px-1.5 py-px text-[11px] font-bold text-accent">
                                      Admin
                                    </span>
                                  )}
                                  {u.id === me?.id && <span className="text-[12px] text-muted">(you)</span>}
                                </div>
                                <div className="truncate text-[13px] text-muted">@{u.username}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">
                            {u.isAdmin ? (
                              <span className="text-muted">Unlimited</span>
                            ) : (
                              <Credits value={u.credits} strong />
                            )}
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">
                            <Credits value={u.spent7d} />
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">
                            <Credits value={u.spent30d} />
                          </td>
                          <td className="px-3 py-3 text-[13px] text-muted" title={u.lastSeen ?? undefined}>
                            {u.lastSeen ? relativeShort(u.lastSeen, tz) : "—"}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setGrantFor(u);
                              }}
                              className="h-8 whitespace-nowrap rounded-full border border-line-strong px-3 text-[13px] font-bold text-ink transition-colors hover:bg-canvas"
                            >
                              Grant / Revoke
                            </button>
                          </td>
                        </tr>
                        {open && (
                          <tr className="border-b border-line last:border-b-0">
                            <td colSpan={6} className="bg-sidebar px-6 py-3">
                              <div className="mb-1 flex items-center justify-between text-[12.5px] text-muted">
                                <span>
                                  Ledger · joined {relativeShort(u.createdAt, tz)}
                                </span>
                                {ledger === "loading" && (
                                  <span className="text-accent">
                                    <Spinner size={14} />
                                  </span>
                                )}
                              </div>
                              {ledger === "error" && <p className="py-3 text-[13px] text-danger">Couldn’t load ledger.</p>}
                              {Array.isArray(ledger) && (
                                <div className="max-h-[360px] overflow-y-auto">
                                  <LedgerList ledger={ledger} tz={tz} />
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-10 text-center text-muted">
                        No users match <span className="text-ink">{q}</span>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <GrantModal user={grantFor} onClose={() => setGrantFor(null)} onDone={onGranted} />
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-2xl border border-line px-4 py-3">
      <div className="text-[13px] text-muted">{label}</div>
      <div className="mt-0.5 text-[22px] font-extrabold tabular-nums tracking-tight text-ink">{formatCredits(value)}</div>
      <div className="text-[12px] text-muted">
        {creditsToUsd(value)}
        {hint ? ` · ${hint}` : ""}
      </div>
    </div>
  );
}

function Credits({ value, strong }: { value: number; strong?: boolean }) {
  return (
    <div className="leading-tight">
      <div className={strong ? "font-bold text-ink" : "text-ink"}>{formatCredits(value)}</div>
      <div className="text-[12px] text-muted">{creditsToUsd(value)}</div>
    </div>
  );
}

const QUICK = [1_000, 10_000, 100_000];

function GrantModal({
  user,
  onClose,
  onDone,
}: {
  user: AdminUser | null;
  onClose: () => void;
  onDone: (u: AdminUser, balance: number) => void | Promise<void>;
}) {
  const { toast } = useApp();
  const [mode, setMode] = useState<"grant" | "revoke">("grant");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset whenever a different user is opened.
  const [forId, setForId] = useState<string | null>(null);
  if ((user?.id ?? null) !== forId) {
    setForId(user?.id ?? null);
    setMode("grant");
    setAmount("");
    setReason("");
    setErr(null);
    setBusy(false);
  }

  const close = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  if (!user) return null;
  const n = Math.floor(Number(amount.replace(/[,_\s]/g, "")));
  const valid = Number.isFinite(n) && n > 0 && n <= 100_000_000;
  const delta = mode === "grant" ? n : -n;
  const after = valid ? Math.max(user.credits + delta, 0) : null;
  const canSubmit = valid && reason.trim().length > 0 && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      const { balance } = await api.adminGrant(user.id, delta, reason.trim());
      await onDone(user, balance);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn’t update credits";
      setErr(msg);
      toast(msg, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={close} labelledBy="grant-title" className="max-w-[420px] p-6">
      <form onSubmit={submit}>
        <div className="flex items-center gap-3">
          <Avatar src={user.profileImageUrl} name={user.name} size={40} />
          <div className="min-w-0 leading-tight">
            <h2 id="grant-title" className="truncate text-xl font-bold text-ink">
              {mode === "grant" ? "Grant credits" : "Revoke credits"}
            </h2>
            <div className="truncate text-[14px] text-muted">
              @{user.username} · {user.isAdmin ? "unlimited (admin)" : `${formatCredits(user.credits)} credits`}
            </div>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 rounded-full bg-hover p-1 text-[14px] font-bold" role="radiogroup">
          {(["grant", "revoke"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={`h-8 rounded-full transition-colors ${
                mode === m ? (m === "grant" ? "bg-canvas text-ink shadow-sm" : "bg-canvas text-danger shadow-sm") : "text-muted"
              }`}
            >
              {m === "grant" ? "Grant" : "Revoke"}
            </button>
          ))}
        </div>

        <label className="mt-4 block">
          <span className="text-[13px] font-semibold text-muted">Amount (credits)</span>
          <input
            data-autofocus
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="e.g. 10,000"
            className="mt-1 h-11 w-full rounded-lg border border-line-strong bg-transparent px-3 text-[16px] tabular-nums text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </label>
        <div className="mt-2 flex flex-wrap gap-2">
          {QUICK.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => {
                const cur = Math.floor(Number(amount.replace(/[,_\s]/g, ""))) || 0;
                setAmount(String(cur + q));
              }}
              className="h-8 rounded-full border border-line-strong px-3 text-[13px] font-bold text-accent transition-colors hover:bg-accent-soft"
            >
              +{formatCredits(q)}
            </button>
          ))}
        </div>

        <label className="mt-4 block">
          <span className="text-[13px] font-semibold text-muted">Reason (required)</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
            placeholder={mode === "grant" ? "e.g. Monthly top-up" : "e.g. Abuse"}
            className="mt-1 h-11 w-full rounded-lg border border-line-strong bg-transparent px-3 text-[15px] text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </label>

        <p className="mt-3 min-h-5 text-[13px] text-muted">
          {valid && !user.isAdmin && (
            <>
              {mode === "grant" ? "+" : "−"}
              {formatCredits(n)} ({creditsToUsd(n)}) → new balance <b className="text-ink">{formatCredits(after!)}</b>
            </>
          )}
          {valid && user.isAdmin && "Admins aren’t charged; the balance only matters if they lose admin."}
        </p>
        {err && <p className="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{err}</p>}

        <div className="mt-4 flex flex-col gap-3">
          <button
            type="submit"
            disabled={!canSubmit}
            className={`h-11 rounded-full text-[15px] font-bold transition-colors disabled:opacity-50 ${
              mode === "grant" ? "bg-ink text-canvas hover:opacity-90" : "bg-danger text-white hover:bg-[#dc1e29]"
            }`}
          >
            {busy ? "Working…" : mode === "grant" ? `Grant${valid ? ` ${formatCredits(n)}` : ""}` : `Revoke${valid ? ` ${formatCredits(n)}` : ""}`}
          </button>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="h-11 rounded-full border border-line-strong text-[15px] font-bold text-ink transition-colors hover:bg-hover disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
