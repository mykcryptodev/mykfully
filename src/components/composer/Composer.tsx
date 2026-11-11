"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { countPost, maxLengthFor } from "@/lib/text";
import { api, ApiError, uuid, type Draft, type ThreadPost } from "../lib/api";
import { formatSchedule, relativeShort } from "../lib/time";
import { tabFor, useApp } from "../app/AppProvider";
import { DRAFT_DELETED_EVENT } from "../sidebar/Sidebar";
import { ConfirmDialog } from "../ui/Modal";
import { Spinner } from "../ui/Spinner";
import { Avatar } from "../ui/Avatar";
import {
  IconAlert,
  IconCheckCircle,
  IconChevronDown,
  IconClock,
  IconExternal,
  IconEye,
  IconHash,
  IconMenu,
  IconPlus,
  IconSend,
  IconTrash,
} from "../ui/icons";
import { PostEditor } from "./PostEditor";
import { Preview } from "./Preview";
import { SchedulePopover } from "./SchedulePopover";

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";
type FocusReq = { id: string; pos: "start" | "end" | number } | null;

const newPost = (text = ""): ThreadPost => ({ id: uuid(), text });
const payload = (posts: ThreadPost[]) => posts.map(({ id, text }) => ({ id, text }));

function usePersistentFlag(key: string, initial: boolean) {
  const [v, setV] = useState(initial);
  useEffect(() => {
    try {
      const s = localStorage.getItem(key);
      if (s != null) setV(s === "1");
    } catch {}
  }, [key]);
  const set = useCallback(
    (next: boolean) => {
      setV(next);
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {}
    },
    [key],
  );
  return [v, set] as const;
}

export function Composer({ routeId }: { routeId: string | null }) {
  const router = useRouter();
  const { me, upsertDraft, removeDraft, setTab, setSidebarOpen, toast } = useApp();
  const tz = me?.timezone ?? "UTC";
  const max = maxLengthFor(me?.verifiedType);

  const [posts, setPosts] = useState<ThreadPost[]>(() => [newPost()]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [focusReq, setFocusReq] = useState<FocusReq>(null);
  const [showPreview, setShowPreview] = usePersistentFlag("myk:preview", false);
  const [numbered, setNumbered] = usePersistentFlag("myk:numbered", false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [busy, setBusy] = useState<null | "schedule" | "publish" | "unschedule" | "delete">(null);
  const [confirm, setConfirm] = useState<null | "publish" | "delete">(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState(0);

  // --- refs for the autosave machinery (avoid stale closures) ---
  const postsRef = useRef(posts);
  postsRef.current = posts;
  const draftIdRef = useRef<string | null>(null);
  const versionRef = useRef(0);
  const savedVersionRef = useRef(0);
  const creatingRef = useRef<Promise<string | null> | null>(null);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readOnlyRef = useRef(false);
  const deletedRef = useRef<Set<string>>(new Set());
  const inputs = useRef(new Map<string, HTMLTextAreaElement>());
  const loadToken = useRef(0);

  const status = draft?.status ?? "draft";
  const readOnly = status === "published" || status === "publishing";
  readOnlyRef.current = readOnly;

  // ---------- saving ----------
  const doPatch = useCallback(async () => {
    const id = draftIdRef.current;
    if (!id || readOnlyRef.current || deletedRef.current.has(id)) return;
    const v = versionRef.current;
    if (v === savedVersionRef.current) return;
    setSaveState("saving");
    try {
      const { draft: d } = await api.updateDraft(id, { posts: payload(postsRef.current) });
      if (draftIdRef.current !== id) return;
      savedVersionRef.current = Math.max(savedVersionRef.current, v);
      setDraft(d);
      upsertDraft(d);
      setSaveState(versionRef.current === savedVersionRef.current ? "saved" : "dirty");
    } catch (e) {
      if (draftIdRef.current !== id) return;
      if (e instanceof ApiError && (e.status === 409 || e.status === 404)) {
        savedVersionRef.current = versionRef.current;
        try {
          const { draft: d } = await api.getDraft(id);
          setDraft(d);
          setPosts(d.posts);
          upsertDraft(d);
          toast(`This draft is ${d.status} and can’t be edited`, "error");
        } catch {
          /* ignore */
        }
        setSaveState("idle");
      } else {
        setSaveState("error");
      }
    }
  }, [upsertDraft, toast]);

  const enqueueSave = useCallback(() => {
    chainRef.current = chainRef.current.then(doPatch, doPatch);
    return chainRef.current;
  }, [doPatch]);

  const ensureCreated = useCallback((): Promise<string | null> => {
    if (draftIdRef.current) return Promise.resolve(draftIdRef.current);
    if (creatingRef.current) return creatingRef.current;
    const token = loadToken.current;
    const p = (async () => {
      setSaveState("saving");
      const v = versionRef.current;
      try {
        const { draft: d } = await api.createDraft(payload(postsRef.current));
        if (token !== loadToken.current) return null; // user moved on
        draftIdRef.current = d.id;
        savedVersionRef.current = v;
        setDraft(d);
        upsertDraft(d);
        setTab("draft");
        // Reflect the new draft in the URL without remounting the composer.
        window.history.replaceState(null, "", `/drafts/${d.id}`);
        if (versionRef.current !== v) void enqueueSave();
        else setSaveState("saved");
        return d.id;
      } catch {
        setSaveState("error");
        creatingRef.current = null;
        return null;
      }
    })();
    creatingRef.current = p;
    return p;
  }, [enqueueSave, upsertDraft, setTab]);

  const markDirty = useCallback(() => {
    versionRef.current++;
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!draftIdRef.current) {
      if (postsRef.current.some((p) => p.text.trim())) void ensureCreated();
      return;
    }
    setSaveState("dirty");
    timerRef.current = setTimeout(() => void enqueueSave(), 800);
  }, [ensureCreated, enqueueSave]);

  /** Persist everything now (before schedule/publish/navigation). */
  const flush = useCallback(async (): Promise<string | null> => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (creatingRef.current) await creatingRef.current;
    if (!draftIdRef.current) return null;
    await enqueueSave();
    return draftIdRef.current;
  }, [enqueueSave]);

  const updatePosts = useCallback(
    (fn: (prev: ThreadPost[]) => ThreadPost[]) => {
      const next = fn(postsRef.current);
      postsRef.current = next;
      setPosts(next);
      markDirty();
    },
    [markDirty],
  );

  // ---------- route changes: load / reset ----------
  useEffect(() => {
    if (routeId && routeId === draftIdRef.current) return; // our own replaceState
    if (!routeId && !draftIdRef.current && !creatingRef.current && newKey === 0) return; // initial blank
    const token = ++loadToken.current;
    let cancelled = false;
    (async () => {
      await flush().catch(() => {});
      if (cancelled || token !== loadToken.current) return;
      // reset machinery
      creatingRef.current = null;
      chainRef.current = Promise.resolve();
      versionRef.current = 0;
      savedVersionRef.current = 0;
      setScheduleOpen(false);
      setNotFound(false);
      if (!routeId) {
        draftIdRef.current = null;
        const p = [newPost()];
        postsRef.current = p;
        setPosts(p);
        setDraft(null);
        setSaveState("idle");
        setFocusReq({ id: p[0].id, pos: "start" });
        return;
      }
      draftIdRef.current = routeId;
      setLoading(true);
      try {
        const { draft: d } = await api.getDraft(routeId);
        if (token !== loadToken.current) return;
        const p = d.posts.length ? d.posts : [newPost()];
        postsRef.current = p;
        setPosts(p);
        setDraft(d);
        setTab(tabFor(d.status));
        setSaveState("idle");
        if (d.status !== "published" && d.status !== "publishing") {
          setFocusReq({ id: p[p.length - 1].id, pos: "end" });
        }
      } catch (e) {
        if (token !== loadToken.current) return;
        draftIdRef.current = null;
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else toast("Couldn’t load draft", "error");
      } finally {
        if (token === loadToken.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId, newKey]);

  // "New draft" clicked while already on "/" (pathname unchanged): listen for a custom event.
  useEffect(() => {
    const onNew = () => setNewKey((k) => k + 1);
    window.addEventListener("mykfully:new-draft", onNew);
    return () => window.removeEventListener("mykfully:new-draft", onNew);
  }, []);

  // drafts deleted from the sidebar: stop saving them
  useEffect(() => {
    const onDeleted = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      deletedRef.current.add(id);
      if (draftIdRef.current === id) {
        if (timerRef.current) clearTimeout(timerRef.current);
        savedVersionRef.current = versionRef.current;
      }
    };
    window.addEventListener(DRAFT_DELETED_EVENT, onDeleted);
    return () => window.removeEventListener(DRAFT_DELETED_EVENT, onDeleted);
  }, []);

  // best-effort save when the tab is closed
  useEffect(() => {
    const onHide = () => {
      const id = draftIdRef.current;
      if (!id || readOnlyRef.current || versionRef.current === savedVersionRef.current) return;
      void fetch(`/api/drafts/${id}`, {
        method: "PATCH",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ posts: payload(postsRef.current) }),
      });
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  // ---------- focus management ----------
  const registerInput = useCallback((id: string, el: HTMLTextAreaElement | null) => {
    if (el) inputs.current.set(id, el);
    else inputs.current.delete(id);
  }, []);

  useEffect(() => {
    if (!focusReq) return;
    const el = inputs.current.get(focusReq.id);
    if (!el) return;
    el.focus();
    const pos = focusReq.pos === "start" ? 0 : focusReq.pos === "end" ? el.value.length : focusReq.pos;
    el.setSelectionRange(pos, pos);
    setFocusReq(null);
  }, [focusReq, posts]);

  // ---------- post operations ----------
  const onChange = useCallback(
    (id: string, text: string) => updatePosts((ps) => ps.map((p) => (p.id === id ? { ...p, text } : p))),
    [updatePosts],
  );

  const onSplitAt = useCallback(
    (id: string, before: string, after: string) => {
      const np = newPost(after);
      updatePosts((ps) => {
        const i = ps.findIndex((p) => p.id === id);
        if (i < 0) return ps;
        const out = [...ps];
        out[i] = { ...out[i], text: before };
        out.splice(i + 1, 0, np);
        return out;
      });
      setFocusReq({ id: np.id, pos: "start" });
    },
    [updatePosts],
  );

  const onInsertAfter = useCallback(
    (id: string) => {
      const np = newPost();
      updatePosts((ps) => {
        const i = ps.findIndex((p) => p.id === id);
        const out = [...ps];
        out.splice(i + 1, 0, np);
        return out;
      });
      setFocusReq({ id: np.id, pos: "start" });
    },
    [updatePosts],
  );

  const addAtEnd = useCallback(() => {
    const np = newPost();
    updatePosts((ps) => [...ps, np]);
    setFocusReq({ id: np.id, pos: "start" });
  }, [updatePosts]);

  const onReplaceWith = useCallback(
    (id: string, texts: string[]) => {
      const created = texts.map((t, k) => (k === 0 ? { id, text: t } : newPost(t)));
      updatePosts((ps) => {
        const i = ps.findIndex((p) => p.id === id);
        if (i < 0) return ps;
        const out = [...ps];
        out.splice(i, 1, ...created);
        return out;
      });
      const last = created[created.length - 1];
      setFocusReq({ id: last.id, pos: "end" });
    },
    [updatePosts],
  );

  const onRemove = useCallback(
    (id: string, focusPrev: boolean) => {
      const ps = postsRef.current;
      if (ps.length <= 1) return;
      const i = ps.findIndex((p) => p.id === id);
      const target = focusPrev ? ps[i - 1] : ps[i + 1];
      updatePosts((list) => list.filter((p) => p.id !== id));
      if (target) setFocusReq({ id: target.id, pos: focusPrev ? "end" : "start" });
    },
    [updatePosts],
  );

  const onMergeUp = useCallback(
    (id: string) => {
      const ps = postsRef.current;
      const i = ps.findIndex((p) => p.id === id);
      if (i <= 0 || ps[i - 1].tweetId) return;
      const prev = ps[i - 1];
      const caret = prev.text.length;
      updatePosts((list) =>
        list.filter((p) => p.id !== id).map((p) => (p.id === prev.id ? { ...p, text: p.text + ps[i].text } : p)),
      );
      setFocusReq({ id: prev.id, pos: caret });
    },
    [updatePosts],
  );

  const onFocusSibling = useCallback((id: string, dir: -1 | 1) => {
    const ps = postsRef.current;
    const i = ps.findIndex((p) => p.id === id);
    const t = ps[i + dir];
    if (t) setFocusReq({ id: t.id, pos: dir === -1 ? "end" : "start" });
  }, []);

  // ---------- validation ----------
  const problems = useMemo(() => {
    if (posts.every((p) => !p.text.trim())) return "Write something first";
    if (posts.some((p) => !p.text.trim() && !p.tweetId)) return "Remove empty posts first";
    if (posts.some((p) => !countPost(p.text, max).valid && !p.tweetId)) return "Some posts are over the character limit";
    return null;
  }, [posts, max]);

  // ---------- actions ----------
  const schedule = async (iso: string) => {
    setBusy("schedule");
    try {
      const id = (await flush()) ?? (await ensureCreated());
      if (!id) throw new Error("Couldn’t save draft");
      const { draft: d } = await api.updateDraft(id, { scheduledAt: iso });
      setDraft(d);
      upsertDraft(d);
      setTab("scheduled");
      setScheduleOpen(false);
      toast(`Scheduled for ${formatSchedule(iso, tz)}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn’t schedule", "error");
    } finally {
      setBusy(null);
    }
  };

  const unschedule = async () => {
    const id = draftIdRef.current;
    if (!id) return;
    setBusy("unschedule");
    try {
      await flush();
      const { draft: d } = await api.updateDraft(id, { scheduledAt: null });
      setDraft(d);
      upsertDraft(d);
      setTab("draft");
      toast("Moved back to drafts");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn’t unschedule", "error");
    } finally {
      setBusy(null);
    }
  };

  const publishNow = async () => {
    setBusy("publish");
    setConfirmError(null);
    let id: string | null = null;
    try {
      id = (await flush()) ?? (await ensureCreated());
      if (!id) throw new Error("Couldn’t save draft");
      const { draft: d } = await api.publish(id);
      setDraft(d);
      setPosts(d.posts);
      postsRef.current = d.posts;
      upsertDraft(d);
      setTab(tabFor(d.status));
      setConfirm(null);
      toast(d.status === "published" ? "Your thread was published" : `Status: ${d.status}`);
    } catch (e) {
      setConfirmError(e instanceof Error ? e.message : "Publishing failed");
      if (id) {
        try {
          const { draft: d } = await api.getDraft(id);
          setDraft(d);
          setPosts(d.posts);
          postsRef.current = d.posts;
          upsertDraft(d);
        } catch {}
      }
    } finally {
      setBusy(null);
    }
  };

  const deleteCurrent = async () => {
    const id = draftIdRef.current;
    setBusy("delete");
    setConfirmError(null);
    try {
      if (creatingRef.current) await creatingRef.current;
      const realId = draftIdRef.current ?? id;
      if (realId) {
        deletedRef.current.add(realId);
        if (timerRef.current) clearTimeout(timerRef.current);
        await api.deleteDraft(realId);
        removeDraft(realId);
      }
      setConfirm(null);
      toast("Draft deleted");
      draftIdRef.current = null;
      creatingRef.current = null;
      if (routeId) router.push("/");
      else setNewKey((k) => k + 1);
    } catch (e) {
      setConfirmError(e instanceof Error ? e.message : "Couldn’t delete");
    } finally {
      setBusy(null);
    }
  };

  const startNew = () => {
    if (routeId || draftIdRef.current) router.push("/");
    else setNewKey((k) => k + 1);
  };

  // ---------- render ----------
  const publishedPosts = posts.filter((p) => p.tweetId);
  const firstTweet = publishedPosts[0]?.tweetId;
  const hasContent = posts.some((p) => p.text.trim());

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">

        {/* top bar */}
        <header className="sticky top-0 z-20 flex h-[53px] shrink-0 items-center gap-2 border-b border-line bg-canvas/85 px-3 backdrop-blur-md sm:px-4">
          <button
            className="rounded-full p-2 text-ink hover:bg-hover md:hidden"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
          >
            <IconMenu size={20} />
          </button>
          <StatusChip draft={draft} tz={tz} />
          <SaveIndicator state={saveState} hidden={readOnly} />
          <span className="flex-1" />

          <button
            onClick={() => setNumbered(!numbered)}
            className={`hidden h-8 items-center gap-1 rounded-full px-2.5 text-[13px] font-semibold transition-colors sm:flex ${
              numbered ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover"
            }`}
            title="Show 1/n numbering"
            aria-pressed={numbered}
          >
            <IconHash size={14} /> 1/{posts.length}
          </button>
          <button
            onClick={() => setShowPreview(!showPreview)}
            className={`flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold transition-colors ${
              showPreview ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover"
            }`}
            aria-pressed={showPreview}
          >
            <IconEye size={15} /> <span className="hidden sm:inline">Preview</span>
          </button>
          {(draftIdRef.current || hasContent) && status !== "publishing" && (
            <button
              onClick={() => {
                setConfirmError(null);
                setConfirm("delete");
              }}
              className="rounded-full p-2 text-muted transition-colors hover:bg-danger/10 hover:text-danger"
              aria-label="Delete draft"
              title="Delete draft"
            >
              <IconTrash size={17} />
            </button>
          )}

          {!readOnly && (
            <>
              <div className="relative">
                <button
                  disabled={!!problems || !!busy}
                  onClick={() => setScheduleOpen((o) => !o)}
                  title={problems ?? (status === "scheduled" ? "Change scheduled time" : "Schedule")}
                  className="flex h-9 items-center gap-1.5 rounded-full border border-line-strong px-3 text-[14px] font-bold text-ink transition-colors hover:bg-hover disabled:opacity-50 sm:px-4"
                >
                  <IconClock size={16} />
                  <span className="hidden sm:inline">{status === "scheduled" ? "Reschedule" : "Schedule"}</span>
                  <IconChevronDown size={14} className="hidden sm:block" />
                </button>
                {scheduleOpen && (
                  <SchedulePopover
                    tz={tz}
                    initial={draft?.scheduledAt ?? null}
                    busy={busy === "schedule"}
                    onSchedule={schedule}
                    onClose={() => setScheduleOpen(false)}
                  />
                )}
              </div>
              <button
                disabled={!!problems || !!busy}
                onClick={() => {
                  setConfirmError(null);
                  setConfirm("publish");
                }}
                title={problems ?? "Publish now"}
                className="flex h-9 items-center gap-1.5 rounded-full bg-accent px-4 text-[14px] font-bold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
              >
                <IconSend size={15} />
                <span className="hidden sm:inline">{status === "failed" ? "Retry now" : "Publish"}</span>
              </button>
            </>
          )}
          {readOnly && (
            <button
              onClick={startNew}
              className="flex h-9 items-center gap-1.5 rounded-full bg-ink px-4 text-[14px] font-bold text-canvas transition-opacity hover:opacity-90"
            >
              <IconPlus size={16} strokeWidth={2.4} /> New draft
            </button>
          )}
        </header>
      <div className="flex min-h-0 flex-1">
      <section className="flex min-w-0 flex-1 flex-col">

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className={`mx-auto w-full max-w-[600px] pb-40 ${showPreview ? "max-lg:hidden" : ""}`}>
            {/* banners */}
            {status === "scheduled" && draft?.scheduledAt && (
              <Banner tone="accent" icon={<IconClock size={18} />}>
                <span className="flex-1">
                  Will post <b>{formatSchedule(draft.scheduledAt, tz)}</b>
                  <span className="text-muted"> ({tz.replace(/_/g, " ")})</span>
                </span>
                <button
                  disabled={!!busy}
                  onClick={unschedule}
                  className="shrink-0 rounded-full px-3 py-1 text-[13px] font-bold text-accent hover:bg-accent/10 disabled:opacity-50"
                >
                  {busy === "unschedule" ? "…" : "Unschedule"}
                </button>
              </Banner>
            )}
            {status === "publishing" && (
              <Banner tone="accent" icon={<Spinner size={16} />}>
                Publishing to X…
              </Banner>
            )}
            {status === "failed" && (
              <Banner tone="danger" icon={<IconAlert size={18} />}>
                <div className="flex-1">
                  <div className="font-bold">Publishing failed{draft && draft.attempts > 0 ? ` after ${draft.attempts} attempt${draft.attempts > 1 ? "s" : ""}` : ""}</div>
                  {draft?.lastError && <div className="mt-0.5 break-words text-[13px] opacity-90">{draft.lastError}</div>}
                  <div className="mt-1 text-[13px] text-muted">
                    Fix the posts if needed, then publish now or reschedule. Posts already on X are kept.
                  </div>
                </div>
              </Banner>
            )}
            {status === "published" && (
              <Banner tone="success" icon={<IconCheckCircle size={18} />}>
                <span className="flex-1">
                  Published{draft?.publishedAt ? ` ${relativeShort(draft.publishedAt, tz)}` : ""} ·{" "}
                  {posts.length} post{posts.length > 1 ? "s" : ""}
                </span>
                {firstTweet && me && (
                  <a
                    href={`https://x.com/${me.username}/status/${firstTweet}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex shrink-0 items-center gap-1 rounded-full px-3 py-1 text-[13px] font-bold text-accent hover:bg-accent/10"
                  >
                    View on X <IconExternal size={13} />
                  </a>
                )}
              </Banner>
            )}

            {notFound ? (
              <div className="px-6 py-20 text-center">
                <p className="text-xl font-bold">Draft not found</p>
                <p className="mt-1 text-muted">It may have been deleted.</p>
                <button onClick={startNew} className="mt-5 h-9 rounded-full bg-ink px-4 font-bold text-canvas">
                  Start a new draft
                </button>
              </div>
            ) : loading ? (
              <div className="flex justify-center py-20 text-accent">
                <Spinner size={26} />
              </div>
            ) : (
              <div className="pt-2">
                {posts.map((p, i) => (
                  <PostEditor
                    key={p.id}
                    post={p}
                    index={i}
                    total={posts.length}
                    me={me}
                    max={max}
                    readOnly={readOnly}
                    showNumber={numbered}
                    autoFocus={!routeId && i === 0 && posts.length === 1}
                    registerInput={registerInput}
                    onChange={onChange}
                    onSplitAt={onSplitAt}
                    onReplaceWith={onReplaceWith}
                    onRemove={onRemove}
                    onMergeUp={onMergeUp}
                    onFocusSibling={onFocusSibling}
                    onInsertAfter={onInsertAfter}
                  />
                ))}
                {!readOnly && (
                  <button
                    onClick={addAtEnd}
                    className="group flex w-full items-center gap-3 px-4 py-2 text-left"
                    aria-label="Add post to thread"
                  >
                    <div className="flex w-10 justify-center">
                      <div className="opacity-40 transition-opacity group-hover:opacity-70">
                        <Avatar src={me?.profileImageUrl} name={me?.name} size={24} />
                      </div>
                    </div>
                    <span className="text-[15px] text-muted transition-colors group-hover:text-accent">
                      Add another post
                    </span>
                  </button>
                )}
                {!readOnly && (
                  <p className="mt-6 px-4 text-center text-[12px] text-faint">
                    <Kbd>⌘</Kbd>
                    <Kbd>Enter</Kbd> or three line breaks to start a new post · <Kbd>@</Kbd> to mention ·{" "}
                    <Kbd>⌫</Kbd> on an empty post to remove it
                  </p>
                )}
              </div>
            )}
          </div>
          {showPreview && (
            <div className="mx-auto w-full max-w-[600px] lg:hidden">
              <PreviewHeader onClose={() => setShowPreview(false)} />
              <Preview posts={posts} me={me} numbered={numbered} />
            </div>
          )}
        </div>
      </section>

      {showPreview && (
        <aside className="hidden w-[360px] shrink-0 flex-col border-l border-line lg:flex xl:w-[420px]">
          <PreviewHeader onClose={() => setShowPreview(false)} />
          <div className="min-h-0 flex-1 overflow-y-auto pb-20">
            <Preview posts={posts} me={me} numbered={numbered} />
          </div>
        </aside>
      )}
      </div>

      <ConfirmDialog
        open={confirm === "publish"}
        title={status === "failed" ? "Retry publishing?" : "Publish thread now?"}
        body={
          <>
            {posts.length > 1 ? `${posts.length} posts` : "Your post"} will be published to X as{" "}
            <b className="text-ink">@{me?.username}</b> right away.
            {status === "scheduled" && " This replaces the scheduled time."}
          </>
        }
        confirmLabel="Publish"
        busy={busy === "publish"}
        error={confirmError}
        onConfirm={publishNow}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        title="Delete draft?"
        body={
          status === "published"
            ? "This removes it from mykfully only. The posts stay on X."
            : "This can’t be undone and the draft will be removed from mykfully."
        }
        confirmLabel="Delete"
        danger
        busy={busy === "delete"}
        error={confirmError}
        onConfirm={deleteCurrent}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mx-0.5 rounded border border-line-strong px-1 py-px font-sans text-[11px] text-muted">{children}</kbd>
  );
}

function PreviewHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="sticky top-0 z-10 flex h-[53px] items-center justify-between border-b border-line bg-canvas/85 px-4 backdrop-blur-md lg:static">
      <div>
        <div className="text-[17px] font-bold leading-5">Preview</div>
        <div className="text-[12px] text-muted">How your thread will look on X</div>
      </div>
      <button onClick={onClose} className="rounded-full px-3 py-1 text-[13px] font-semibold text-muted hover:bg-hover">
        Hide
      </button>
    </div>
  );
}

function Banner({
  tone,
  icon,
  children,
}: {
  tone: "accent" | "danger" | "success";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const cls =
    tone === "danger"
      ? "bg-danger/8 text-danger border-danger/20"
      : tone === "success"
        ? "bg-success/8 text-ink border-success/25"
        : "bg-accent-soft text-ink border-accent/20";
  const iconCls = tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : "text-accent";
  return (
    <div className={`mx-4 mt-3 flex items-start gap-3 rounded-xl border px-4 py-3 text-[14px] ${cls}`}>
      <span className={`mt-px shrink-0 ${iconCls}`}>{icon}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function StatusChip({ draft, tz }: { draft: Draft | null; tz: string }) {
  const status = draft?.status ?? "draft";
  const map = {
    draft: { label: draft ? "Draft" : "New draft", cls: "bg-hover text-muted" },
    scheduled: { label: "Scheduled", cls: "bg-accent-soft text-accent" },
    publishing: { label: "Publishing", cls: "bg-accent-soft text-accent" },
    published: { label: "Published", cls: "bg-success/12 text-success" },
    failed: { label: "Failed", cls: "bg-danger/10 text-danger" },
  } as const;
  const { label, cls } = map[status];
  return (
    <span className={`inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-[12px] font-bold ${cls}`}>
      {label}
      {status === "scheduled" && draft?.scheduledAt && (
        <span className="hidden font-medium lg:inline">· {formatSchedule(draft.scheduledAt, tz)}</span>
      )}
    </span>
  );
}

function SaveIndicator({ state, hidden }: { state: SaveState; hidden: boolean }) {
  if (hidden || state === "idle") return null;
  const text =
    state === "saving" || state === "dirty" ? "Saving…" : state === "saved" ? "Saved" : "Not saved · retrying on next edit";
  return (
    <span
      className={`hidden items-center gap-1 text-[12px] sm:inline-flex ${state === "error" ? "text-danger" : "text-muted"}`}
      aria-live="polite"
    >
      {state === "saved" && <IconCheckCircle size={13} />}
      {text}
    </span>
  );
}
