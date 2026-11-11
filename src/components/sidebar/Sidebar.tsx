"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api, type Draft } from "../lib/api";
import { browserTimezone, formatSchedule, listTimezones, relativeShort } from "../lib/time";
import { tabFor, useApp, type ListTab } from "../app/AppProvider";
import { Avatar } from "../ui/Avatar";
import { VerifiedBadge } from "../ui/VerifiedBadge";
import { ConfirmDialog } from "../ui/Modal";
import { CreditsChip } from "../credits/CreditsChip";
import {
  IconAlert,
  IconCheck,
  IconCheckCircle,
  IconClock,
  IconCopy,
  IconDoc,
  IconGlobe,
  IconLogout,
  IconPlus,
  IconShield,
  IconTrash,
  IconX,
} from "../ui/icons";

export const DRAFT_DELETED_EVENT = "mykfully:draft-deleted";

const TABS: { key: ListTab; label: string; Icon: typeof IconDoc }[] = [
  { key: "draft", label: "Drafts", Icon: IconDoc },
  { key: "scheduled", label: "Scheduled", Icon: IconClock },
  { key: "published", label: "Published", Icon: IconCheckCircle },
  { key: "failed", label: "Failed", Icon: IconAlert },
];

export function Logo() {
  return (
    <div className="flex items-center gap-2 text-[17px] font-extrabold tracking-tight text-ink">
      <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="8" fill="#1d9bf0" />
        <path
          d="M8 23V13.5c0-1.9 1.4-3.3 3.2-3.3 1.2 0 2.2.6 2.8 1.6.6-1 1.6-1.6 2.8-1.6 1.8 0 3.2 1.4 3.2 3.3V23M14 13.5V23M24 10v13" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
        />
      </svg>
      mykfully
    </div>
  );
}

function previewText(d: Draft): string {
  const first = d.posts.find((p) => p.text.trim())?.text.trim();
  return first ?? "";
}

export function Sidebar() {
  const { me, setMe, drafts, draftsLoaded, tab, setTab, sidebarOpen, setSidebarOpen, removeDraft, toast } = useApp();
  const router = useRouter();
  const pathname = usePathname();
  const openId = pathname.startsWith("/drafts/") ? pathname.slice("/drafts/".length) : null;
  const [pendingDelete, setPendingDelete] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [timezones, setTimezones] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const tz = me?.timezone ?? "UTC";

  useEffect(() => setTimezones(listTimezones()), []);

  const counts = useMemo(() => {
    const c: Record<ListTab, number> = { draft: 0, scheduled: 0, published: 0, failed: 0 };
    for (const d of drafts) c[tabFor(d.status)]++;
    return c;
  }, [drafts]);

  const list = useMemo(() => {
    const items = drafts.filter((d) => tabFor(d.status) === tab);
    if (tab === "scheduled") items.sort((a, b) => (a.scheduledAt ?? "").localeCompare(b.scheduledAt ?? ""));
    else if (tab === "published") items.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
    else items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return items;
  }, [drafts, tab]);

  const go = (href: string) => {
    if (href === "/" && pathname === "/") window.dispatchEvent(new Event("mykfully:new-draft"));
    else router.push(href);
    setSidebarOpen(false);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const id = pendingDelete.id;
      window.dispatchEvent(new CustomEvent(DRAFT_DELETED_EVENT, { detail: id }));
      await api.deleteDraft(id);
      removeDraft(id);
      setPendingDelete(null);
      toast("Draft deleted");
      if (openId === id) router.push("/");
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Couldn't delete");
    } finally {
      setDeleting(false);
    }
  };

  const changeTz = async (value: string) => {
    try {
      const { user } = await api.setTimezone(value);
      setMe(user);
      toast(`Timezone set to ${value.replace(/_/g, " ")}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't update timezone", "error");
    }
  };

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      window.location.href = "/login";
    }
  };

  const copyXId = async () => {
    if (!me?.xUserId) return;
    try {
      await navigator.clipboard.writeText(me.xUserId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast("Couldn’t copy — select the ID manually", "error");
    }
  };

  const browserTz = typeof window !== "undefined" ? browserTimezone() : null;

  return (
    <>
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-overlay md:hidden" onClick={() => setSidebarOpen(false)} aria-hidden />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[280px] flex-col border-r-[0.5px] border-line-strong bg-sidebar transition-transform duration-200 md:static md:z-auto md:translate-x-0 ${
          sidebarOpen ? "translate-x-0 shadow-pop" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <Logo />
          <button
            className="rounded-full p-1.5 text-muted hover:bg-hover md:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
          >
            <IconX size={18} />
          </button>
        </div>

        <div className="px-3 pb-3 pt-2">
          <button
            onClick={() => go("/")}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-full bg-ink text-[15px] font-bold text-canvas transition-opacity hover:opacity-90"
          >
            <IconPlus size={18} strokeWidth={2.4} />
            New draft
          </button>
        </div>

        <nav className="flex flex-col gap-0.5 px-2" aria-label="Draft lists">
          {TABS.map(({ key, label, Icon }) => {
            const active = tab === key;
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                aria-current={active ? "page" : undefined}
                className={`flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors ${
                  active ? "bg-hover font-semibold text-ink" : "text-ink/80 hover:bg-hover"
                }`}
              >
                <Icon size={16} className={key === "failed" && counts.failed > 0 ? "text-danger" : "text-muted"} />
                <span className="flex-1 text-left">{label}</span>
                <span
                  className={`min-w-5 rounded-full px-1.5 text-center text-xs tabular-nums ${
                    key === "failed" && counts.failed > 0 ? "bg-danger/10 font-semibold text-danger" : "text-muted"
                  }`}
                >
                  {draftsLoaded ? counts[key] : ""}
                </span>
              </button>
            );
          })}
          {me?.isAdmin && (
            <button
              onClick={() => go("/admin")}
              aria-current={pathname === "/admin" ? "page" : undefined}
              className={`flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors ${
                pathname === "/admin" ? "bg-hover font-semibold text-ink" : "text-ink/80 hover:bg-hover"
              }`}
            >
              <IconShield size={16} className="text-muted" />
              <span className="flex-1 text-left">Admin</span>
            </button>
          )}
        </nav>

        <div className="mx-3 mt-3 border-t-[0.5px] border-line-strong" />

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {draftsLoaded && list.length === 0 && (
            <p className="px-3 py-6 text-center text-[13px] text-muted">
              {tab === "draft" && "No drafts yet. Start writing!"}
              {tab === "scheduled" && "Nothing scheduled."}
              {tab === "published" && "Nothing published yet."}
              {tab === "failed" && "No failed posts. Nice."}
            </p>
          )}
          <ul className="flex flex-col gap-0.5">
            {list.map((d) => {
              const text = previewText(d);
              const active = d.id === openId;
              const meta =
                d.status === "scheduled" && d.scheduledAt
                  ? formatSchedule(d.scheduledAt, tz)
                  : d.status === "publishing"
                    ? "Publishing…"
                    : d.status === "published" && d.publishedAt
                      ? `Posted ${relativeShort(d.publishedAt, tz)}`
                      : relativeShort(d.updatedAt, tz);
              return (
                <li key={d.id} className="group relative">
                  <button
                    onClick={() => go(`/drafts/${d.id}`)}
                    className={`w-full rounded-lg px-3 py-2.5 text-left transition-colors ${
                      active ? "bg-canvas shadow-[0_0_0_0.5px_var(--line-strong)]" : "hover:bg-hover"
                    }`}
                  >
                    <p
                      className={`line-clamp-2 break-words pr-5 text-[13.5px] leading-[18px] ${
                        text ? "text-ink" : "italic text-muted"
                      }`}
                    >
                      {text || "Empty draft"}
                    </p>
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                      {d.status === "scheduled" && <IconClock size={12} />}
                      {d.status === "failed" && <IconAlert size={12} className="text-danger" />}
                      <span>{meta}</span>
                      {d.posts.length > 1 && (
                        <>
                          <span aria-hidden>·</span>
                          <span>{d.posts.length} posts</span>
                        </>
                      )}
                    </p>
                  </button>
                  {d.status !== "publishing" && (
                    <button
                      onClick={() => {
                        setDeleteError(null);
                        setPendingDelete(d);
                      }}
                      className="absolute right-1.5 top-2 rounded-full p-1.5 text-muted opacity-0 transition hover:bg-danger/10 hover:text-danger focus:opacity-100 group-hover:opacity-100"
                      aria-label="Delete draft"
                      title="Delete"
                    >
                      <IconTrash size={14} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        <div className="border-t-[0.5px] border-line-strong p-3">
          <CreditsChip />
          {me && (
            <label className="mb-2 flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-hover">
              <IconGlobe size={14} />
              <span className="sr-only">Timezone</span>
              <select
                value={me.timezone}
                onChange={(e) => changeTz(e.target.value)}
                className="min-w-0 flex-1 cursor-pointer appearance-none truncate bg-transparent text-xs text-ink outline-none"
                title="Timezone used for scheduling"
              >
                {(timezones.includes(me.timezone) ? timezones : [me.timezone, ...timezones]).map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, " ")}
                    {z === browserTz ? " (this device)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="flex items-center gap-2.5 rounded-full px-1 py-1">
            <Avatar src={me?.profileImageUrl} name={me?.name} size={36} />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="flex items-center gap-0.5">
                <span className="truncate text-[14px] font-bold text-ink">{me?.name ?? " "}</span>
                <VerifiedBadge type={me?.verifiedType} size={16} />
              </div>
              <div className="truncate text-[13px] text-muted">{me ? `@${me.username}` : " "}</div>
            </div>
            <button
              onClick={logout}
              className="rounded-full p-2 text-muted transition-colors hover:bg-hover hover:text-ink"
              aria-label="Log out"
              title="Log out"
            >
              <IconLogout size={17} />
            </button>
          </div>
          {me?.xUserId && (
            <div className="mt-1 px-2 text-[11.5px] leading-4 text-faint">
              <div className="flex items-center gap-1">
                <span className="min-w-0 truncate">
                  Your X user ID: <span className="select-all font-mono text-muted">{me.xUserId}</span>
                </span>
                <button
                  onClick={copyXId}
                  className="shrink-0 rounded-full p-1 text-muted transition-colors hover:bg-hover hover:text-ink"
                  aria-label="Copy X user ID"
                  title={copied ? "Copied" : "Copy"}
                >
                  {copied ? <IconCheck size={12} className="text-success" /> : <IconCopy size={12} />}
                </button>
              </div>
              {!me.isAdmin && (
                <div>
                  Add it to <code className="font-mono">ADMIN_X_USER_IDS</code> to become admin
                </div>
              )}
            </div>
          )}
        </div>
      </aside>

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete draft?"
        body="This can’t be undone and the draft will be removed from mykfully."
        confirmLabel="Delete"
        danger
        busy={deleting}
        error={deleteError}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}
