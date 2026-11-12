"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { countPost, hasUrl, maxLengthFor } from "@/lib/text";
import { MAX_DRAFT_POSTS, MAX_DRAFT_POST_CODE_UNITS } from "@/lib/draft-limits";
import {
  api,
  ApiError,
  creditErrorMessage,
  creditsToUsd,
  formatCredits,
  uuid,
  type CreditCosts,
  type Draft,
  type ThreadPost,
} from "../lib/api";
import { formatSchedule, relativeShort } from "../lib/time";
import { tabFor, useApp } from "../app/AppProvider";
import { DRAFT_DELETED_EVENT } from "../sidebar/Sidebar";
import { ConfirmDialog } from "../ui/Modal";
import { Spinner } from "../ui/Spinner";
import {
  IconAlert,
  IconCalendar,
  IconCheckCircle,
  IconClock,
  IconExternal,
  IconEye,
  IconFocus,
  IconHash,
  IconMenu,
  IconPen,
  IconPlus,
  IconSearch,
  IconTrash,
  IconX,
} from "../ui/icons";
import { CommandBar, type ComposerCommand } from "./CommandBar";
import { PostEditor } from "./PostEditor";
import { PreviewPanel } from "./Preview";
import { SchedulePopover } from "./SchedulePopover";

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";
type FocusReq = {
  id: string;
  pos: "start" | "end" | number;
  end?: number;
  direction?: HTMLTextAreaElement["selectionDirection"];
} | null;

const newPost = (text = ""): ThreadPost => ({ id: uuid(), text });

const DEFAULT_COSTS: CreditCosts = { post: 15, postWithUrl: 200, userRead: 10 };

/** Same rules as the server's estimateThreadCost: unposted, non-empty posts; links cost more. */
function estimateCost(posts: ThreadPost[], costs: CreditCosts): number {
  return posts
    .filter((p) => !p.tweetId && p.text.trim())
    .reduce((sum, p) => sum + (hasUrl(p.text) ? costs.postWithUrl : costs.post), 0);
}

/** "[code] message" → { code, message } (lastError prefixes written by the scheduler). */
function parseLastError(err: string): { code: string | null; message: string } {
  const m = err.match(/^\[([a-z_]+)\]\s*([\s\S]*)$/);
  return m ? { code: m[1], message: m[2] } : { code: null, message: err };
}
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

export function Composer({
  routeId,
  active,
  focusMode,
  onFocusModeChange,
  sidebarCollapsed,
  onSidebarToggle,
}: {
  routeId: string | null;
  active: boolean;
  focusMode: boolean;
  onFocusModeChange: (enabled: boolean) => void;
  sidebarCollapsed: boolean;
  onSidebarToggle: () => void;
}) {
  const router = useRouter();
  const { me, credits, buyCredits, refreshMe, upsertDraft, removeDraft, setTab, sidebarOpen, setSidebarOpen, toast } = useApp();
  const tz = me?.timezone ?? "UTC";
  const max = maxLengthFor(me?.verifiedType);

  const [posts, setPosts] = useState<ThreadPost[]>(() => [newPost()]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [focusReq, setFocusReq] = useState<FocusReq>(null);
  const [desktopPreview, setDesktopPreview] = usePersistentFlag("myk:preview", false);
  const [mobilePreview, setMobilePreview] = useState(false);
  const [wideViewport, setWideViewport] = useState(false);
  const [mobileDevice, setMobileDevice] = usePersistentFlag("myk:preview-mobile", false);
  const [numbered, setNumbered] = usePersistentFlag("myk:numbered", false);
  const [writingMode, setWritingMode] = usePersistentFlag("myk:writing-mode", false);
  const [mobileWidth, setMobileWidth] = usePersistentFlag("myk:editor-mobile", false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [busy, setBusy] = useState<null | "schedule" | "publish" | "unschedule" | "delete" | "duplicate">(null);
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
  const lastFocusedPost = useRef<string | null>(null);
  const previewButtonRef = useRef<HTMLButtonElement>(null);
  const scheduleButtonRef = useRef<HTMLButtonElement>(null);
  const restoreScheduleFocus = useRef(false);
  const loadToken = useRef(0);

  const status = draft?.status ?? "draft";
  const readOnly = status === "published" || status === "publishing";
  readOnlyRef.current = readOnly;

  useEffect(() => {
    const media = window.matchMedia("(min-width: 64rem)");
    const update = () => {
      setWideViewport(media.matches);
      if (media.matches) setMobilePreview(false);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

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
      if (e instanceof ApiError && e.status === 409) {
        try {
          const { draft: d } = await api.getDraft(id);
          if (draftIdRef.current !== id) return;
          upsertDraft(d);
          if (d.status === "published" || d.status === "publishing") {
            savedVersionRef.current = versionRef.current;
            postsRef.current = d.posts;
            setDraft(d);
            setPosts(d.posts);
            setSaveState("idle");
            toast(`This draft is ${d.status} and can’t be edited`, "error");
            return;
          }
        } catch {}
      }
      if (draftIdRef.current === id) setSaveState("error");
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
        draftIdRef.current = d.id;
        savedVersionRef.current = v;
        setDraft(d);
        upsertDraft(d);
        // Reflect the new draft in the URL without remounting the composer.
        if (token === loadToken.current) {
          setTab("draft");
          window.history.replaceState(null, "", `/drafts/${d.id}`);
        }
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
      if (next === postsRef.current) return;
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
      setCommandOpen(false);
      setConfirm(null);
      setMobilePreview(false);
      restoreScheduleFocus.current = false;
      setNotFound(false);
      if (!routeId) {
        draftIdRef.current = null;
        setLoading(false);
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
    el.setSelectionRange(pos, focusReq.end ?? pos, focusReq.direction ?? undefined);
    setFocusReq(null);
  }, [focusReq, posts]);

  // ---------- post operations ----------
  const onChange = useCallback(
    (id: string, text: string) => updatePosts((ps) => ps.map((p) => (p.id === id ? { ...p, text } : p))),
    [updatePosts],
  );

  const onSplitAt = useCallback(
    (id: string, before: string, after: string) => {
      if (postsRef.current.length >= MAX_DRAFT_POSTS) return;
      const np = newPost(after);
      updatePosts((ps) => {
        const i = ps.findIndex((p) => p.id === id);
        if (i < 0 || ps[i].tweetId || ps[i + 1]?.tweetId) return ps;
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
      if (postsRef.current.length >= MAX_DRAFT_POSTS) return;
      const np = newPost();
      updatePosts((ps) => {
        const i = ps.findIndex((p) => p.id === id);
        if (i < 0 || ps[i + 1]?.tweetId) return ps;
        const out = [...ps];
        out.splice(i + 1, 0, np);
        return out;
      });
      setFocusReq({ id: np.id, pos: "start" });
    },
    [updatePosts],
  );

  const onMove = useCallback((id: string, direction: -1 | 1) => {
    const current = postsRef.current;
    const index = current.findIndex((post) => post.id === id);
    const other = index + direction;
    if (readOnlyRef.current || index < 0 || !current[other] || current[index].tweetId || current[other].tweetId) return;

    const input = inputs.current.get(id);
    const next = [...current];
    [next[index], next[other]] = [next[other], next[index]];
    updatePosts(() => next);
    setFocusReq({ id, pos: input?.selectionStart ?? "end", end: input?.selectionEnd, direction: input?.selectionDirection });
  }, [updatePosts]);

  const onReplaceWith = useCallback(
    (id: string, texts: string[]) => {
      if (!texts.length || postsRef.current.length + texts.length - 1 > MAX_DRAFT_POSTS) return;
      const created = texts.map((t, k) => (k === 0 ? { id, text: t } : newPost(t)));
      updatePosts((ps) => {
        const i = ps.findIndex((p) => p.id === id);
        if (i < 0 || ps[i].tweetId || ps[i + 1]?.tweetId) return ps;
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
      if (prev.text.length + ps[i].text.length > MAX_DRAFT_POST_CODE_UNITS) return;
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

  // ---------- credits ----------
  const costs = credits?.costs ?? DEFAULT_COSTS;
  const isAdmin = credits?.isAdmin ?? me?.isAdmin ?? false;
  const balance = credits?.balance ?? me?.credits ?? 0;
  const estimate = useMemo(() => estimateCost(posts, costs), [posts, costs]);
  const shortCredits =
    !!me && !isAdmin && estimate > balance
      ? `Not enough credits (need ${formatCredits(estimate)}, have ${formatCredits(balance)}). Ask the admin for more.`
      : null;
  const blocked = problems ?? shortCredits;

  // ---------- actions ----------
  const schedule = async (iso: string) => {
    const token = loadToken.current;
    setBusy("schedule");
    try {
      const id = (await flush()) ?? (await ensureCreated());
      if (!id) throw new Error("Couldn’t save draft");
      if (token !== loadToken.current) return;
      if (versionRef.current !== savedVersionRef.current) throw new Error("Couldn’t save the latest edits");
      const { draft: d } = await api.updateDraft(id, { scheduledAt: iso });
      upsertDraft(d);
      if (token === loadToken.current && draftIdRef.current === id) {
        setDraft(d);
        setTab("scheduled");
        restoreScheduleFocus.current = true;
        setScheduleOpen(false);
      }
      toast(`Scheduled for ${formatSchedule(iso, tz)}`);
    } catch (e) {
      toast(creditErrorMessage(e) ?? (e instanceof Error ? e.message : "Couldn’t schedule"), "error");
    } finally {
      setBusy(null);
      void refreshMe();
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
      if (versionRef.current !== savedVersionRef.current) {
        setConfirmError("Couldn’t save the latest edits. Try again.");
        return;
      }
      const { draft: d } = await api.publish(id);
      setDraft(d);
      setPosts(d.posts);
      postsRef.current = d.posts;
      upsertDraft(d);
      setTab(tabFor(d.status));
      setConfirm(null);
      toast(d.status === "published" ? "Your thread was published" : `Status: ${d.status}`);
    } catch (e) {
      const friendly = creditErrorMessage(e);
      setConfirmError(friendly ?? (e instanceof Error ? e.message : "Publishing failed"));
      if (friendly) toast(friendly, "error");
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
      void refreshMe();
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

  const startNew = useCallback(() => {
    if (routeId || draftIdRef.current) router.push("/");
    else setNewKey((k) => k + 1);
  }, [routeId, router]);

  const duplicateDraft = async () => {
    setBusy("duplicate");
    const token = loadToken.current;
    try {
      const { draft: copy } = await api.createDraft(postsRef.current.map((post) => newPost(post.text)));
      upsertDraft(copy);
      toast("Draft duplicated");
      if (loadToken.current === token) router.push(`/drafts/${copy.id}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn’t duplicate draft", "error");
    } finally {
      setBusy(null);
    }
  };

  const openPublishConfirmation = useCallback(() => {
    setConfirmError(null);
    setConfirm("publish");
  }, []);

  const changeFocusMode = useCallback((enabled: boolean) => {
    onFocusModeChange(enabled);
    const input = inputs.current.get(lastFocusedPost.current ?? "") ?? inputs.current.values().next().value;
    input?.focus({ preventScroll: true });
  }, [onFocusModeChange]);

  const showPreview = !focusMode && (wideViewport ? desktopPreview : mobilePreview);
  const togglePreview = () => {
    if (wideViewport) setDesktopPreview(!desktopPreview);
    else setMobilePreview(!mobilePreview);
  };

  const closePreview = () => {
    if (wideViewport) setDesktopPreview(false);
    else setMobilePreview(false);
    previewButtonRef.current?.focus();
  };

  useEffect(() => {
    if (busy || !restoreScheduleFocus.current) return;
    restoreScheduleFocus.current = false;
    scheduleButtonRef.current?.focus();
  }, [busy]);

  useEffect(() => {
    if (!active || confirm || scheduleOpen || commandOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey) return;
      if (event.key === "Escape") {
        if (focusMode) changeFocusMode(false);
        else if (mobilePreview) {
          setMobilePreview(false);
          previewButtonRef.current?.focus();
        }
        return;
      }
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey && event.code === "KeyF") {
        event.preventDefault();
        changeFocusMode(!focusMode);
      } else if (event.shiftKey && event.code === "KeyH") {
        event.preventDefault();
        setMobileWidth(!mobileWidth);
      } else if (!focusMode && !event.shiftKey && event.code === "KeyK") {
        event.preventDefault();
        setCommandOpen(true);
      } else if (!focusMode && !event.shiftKey && event.code === "Period") {
        event.preventDefault();
        startNew();
      } else if (!focusMode && !event.shiftKey && event.code === "Slash") {
        event.preventDefault();
        if (window.matchMedia("(min-width: 48rem)").matches) onSidebarToggle();
        else setSidebarOpen(!sidebarOpen);
      } else if (!focusMode && event.shiftKey && event.key === "Enter" && !readOnly && !blocked && !busy && !loading) {
        event.preventDefault();
        openPublishConfirmation();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    active, blocked, busy, changeFocusMode, commandOpen, confirm, focusMode, loading, mobilePreview, mobileWidth,
    onSidebarToggle, openPublishConfirmation, readOnly, scheduleOpen, setMobileWidth, setSidebarOpen, sidebarOpen, startNew,
  ]);

  // ---------- render ----------
  const publishedPosts = posts.filter((p) => p.tweetId);
  const firstTweet = publishedPosts[0]?.tweetId;
  const hasContent = posts.some((p) => p.text.trim());
  const commands: ComposerCommand[] = [
    { label: "New draft", shortcut: "⌘/Ctrl .", run: startNew },
    { label: showPreview ? "Hide X preview" : "Show X preview", run: togglePreview },
    { label: "Enter focus mode", shortcut: "⌘/Ctrl ⇧ F", run: () => changeFocusMode(true) },
    { label: mobileWidth ? "Switch to desktop width" : "Switch to mobile width", shortcut: "⌘/Ctrl ⇧ H", run: () => setMobileWidth(!mobileWidth) },
    { label: writingMode ? "Show X profile" : "Hide X profile for writing", run: () => setWritingMode(!writingMode) },
    { label: numbered ? "Hide post numbers" : "Show post numbers", run: () => setNumbered(!numbered) },
  ];
  if (hasContent && !busy) commands.push({ label: "Duplicate draft", keywords: "copy", run: duplicateDraft });
  if (!readOnly && !blocked && !busy) {
    commands.push(
      { label: status === "scheduled" ? "Reschedule draft" : "Schedule draft", run: () => setScheduleOpen(true) },
      { label: status === "failed" ? "Retry publishing" : "Publish now", shortcut: "⌘/Ctrl ⇧ ↵", run: openPublishConfirmation },
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">

        {/* top bar */}
        {focusMode ? (
          <header className="flex h-12 shrink-0 items-center justify-between px-3 text-sm text-muted sm:px-4">
            <span>Press <kbd className="rounded border border-line px-1.5 py-0.5 text-xs">Esc</kbd> to exit focus mode</span>
            <button
              type="button"
              aria-label="Exit focus mode"
              onClick={() => changeFocusMode(false)}
              className="rounded-lg p-2 hover:bg-hover hover:text-ink"
            >
              <IconX size={17} />
            </button>
          </header>
        ) : (
        <header className="relative z-20 flex h-12 shrink-0 items-center gap-1 border-b border-line bg-canvas px-2 sm:gap-2 sm:px-4">
          {!focusMode && (
            <button
              className="rounded-lg p-2 text-ink hover:bg-hover md:hidden"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open menu"
            >
              <IconMenu size={19} />
            </button>
          )}
          <button
            className="hidden rounded-lg p-2 text-muted hover:bg-hover md:inline-flex"
            onClick={onSidebarToggle}
            aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            aria-keyshortcuts="Meta+/ Control+/"
          >
            <IconMenu size={17} />
          </button>
          <StatusChip draft={draft} tz={tz} />
          <SaveIndicator state={saveState} hidden={readOnly} />
          <span className="flex-1" />

          <button
            onClick={() => setCommandOpen(true)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-hover"
            aria-label="Open command bar"
            aria-haspopup="dialog"
            aria-keyshortcuts="Meta+K Control+K"
            title="Open command bar"
          >
            <IconSearch size={16} />
          </button>
          <button
            ref={previewButtonRef}
            onClick={togglePreview}
            className={`flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-semibold transition-colors ${
              showPreview ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover"
            }`}
            aria-label="Preview"
            aria-pressed={showPreview}
            title="Preview"
          >
            <IconEye size={17} /> <span className="hidden xl:inline">Preview</span>
          </button>
          {(draftIdRef.current || hasContent) && status !== "publishing" && (
            <button
              onClick={() => {
                setConfirmError(null);
                setConfirm("delete");
              }}
              className="rounded-lg p-2 text-muted transition-colors hover:bg-danger/10 hover:text-danger"
              aria-label="Delete draft"
              title="Delete draft"
            >
              <IconTrash size={17} />
            </button>
          )}

          {!readOnly && (
            <>
              {estimate > 0 && (
                <span
                  className={`hidden whitespace-nowrap px-1 text-[12px] tabular-nums lg:inline ${
                    shortCredits ? "font-semibold text-danger" : "text-muted"
                  }`}
                  title={
                    shortCredits ??
                    `Estimated cost: ${formatCredits(estimate)} credits (${creditsToUsd(estimate)})${isAdmin ? " · unmetered for admins" : ""}`
                  }
                >
                  ≈ {formatCredits(estimate)} credits
                </span>
              )}
              <div className="relative">
                <button
                  ref={scheduleButtonRef}
                  disabled={!!blocked || !!busy}
                  onClick={() => setScheduleOpen((o) => !o)}
                  title={blocked ?? (status === "scheduled" ? "Change scheduled time" : "Schedule")}
                  aria-label={status === "scheduled" ? "Reschedule" : "Schedule"}
                  aria-expanded={scheduleOpen}
                  aria-haspopup="dialog"
                  className="flex h-8 items-center gap-1.5 rounded-lg bg-schedule px-2.5 text-[13px] font-semibold text-on-schedule transition-colors hover:bg-schedule-hover disabled:opacity-50"
                >
                  <IconCalendar size={15} className="sm:hidden" />
                  <span className="hidden sm:inline">{status === "scheduled" ? "Reschedule" : "Schedule"}</span>
                </button>
                {scheduleOpen && (
                  <SchedulePopover
                    anchorRef={scheduleButtonRef}
                    tz={tz}
                    initial={draft?.scheduledAt ?? null}
                    busy={busy === "schedule"}
                    onSchedule={schedule}
                    onClose={() => setScheduleOpen(false)}
                  />
                )}
              </div>
              <button
                disabled={!!blocked || !!busy}
                onClick={openPublishConfirmation}
                title={blocked ?? "Publish now"}
                aria-keyshortcuts="Meta+Shift+Enter Control+Shift+Enter"
                className="flex h-8 items-center rounded-lg bg-accent px-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50 sm:px-3"
              >
                {status === "failed" ? "Retry" : "Publish"}
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
        )}
      <div className="flex min-h-0 flex-1">
      <section
        aria-label="Thread editor"
        className={`min-w-0 flex-1 flex-col ${showPreview && !wideViewport ? "hidden" : "flex"}`}
        onFocusCapture={(event) => {
          if (!(event.target instanceof HTMLTextAreaElement)) return;
          for (const [id, input] of inputs.current) {
            if (input === event.target) {
              lastFocusedPost.current = id;
              break;
            }
          }
        }}
      >

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className={`mx-auto w-full px-1 pb-8 pt-2 sm:px-4 sm:pt-3 ${mobileWidth ? "max-w-[410px]" : "max-w-[620px]"}`}>
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
            {shortCredits && !readOnly && !problems && (
              <Banner tone="danger" icon={<IconAlert size={18} />}>
                <span className="flex-1">{shortCredits}</span>
                {buyCredits && <BuyCreditsButton onClick={buyCredits} />}
              </Banner>
            )}
            {status === "failed" && (
              <Banner tone="danger" icon={<IconAlert size={18} />}>
                <div className="flex-1">
                  <div className="font-bold">Publishing failed{draft && draft.attempts > 0 ? ` after ${draft.attempts} attempt${draft.attempts > 1 ? "s" : ""}` : ""}</div>
                  {draft?.lastError && <FailedReason error={draft.lastError} balance={isAdmin ? null : balance} onBuy={isAdmin ? null : buyCredits} />}
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
                    displayMode={writingMode ? "writing" : "social"}
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
                    onMove={onMove}
                    canMoveUp={i > 0 && !posts[i - 1].tweetId}
                    canMoveDown={i < posts.length - 1 && !posts[i + 1].tweetId}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
        {!focusMode && (
          <div role="group" aria-label="Composer display" className="mx-auto mb-3 flex shrink-0 items-center gap-1 rounded-full border border-line bg-sidebar p-1">
            <button type="button" aria-label="Show post numbers" aria-pressed={numbered} title="Show post numbers" onClick={() => setNumbered(!numbered)}
              className={`rounded-full p-2 ${numbered ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover"}`}>
              <IconHash size={15} />
            </button>
            <button type="button" aria-label="Writing view" aria-pressed={writingMode} title="Writing view" onClick={() => setWritingMode(!writingMode)}
              className={`rounded-full p-2 ${writingMode ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover"}`}>
              <IconPen size={15} />
            </button>
            <button type="button" aria-label="Mobile editor width" aria-pressed={mobileWidth} title="Toggle desktop or mobile editor width"
              aria-keyshortcuts="Meta+Shift+H Control+Shift+H" onClick={() => setMobileWidth(!mobileWidth)}
              className={`rounded-full px-2 py-1.5 text-xs font-medium ${mobileWidth ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover"}`}>
              {mobileWidth ? "Mobile" : "Desktop"}
            </button>
            <button type="button" aria-label="Focus mode" title="Focus mode" aria-keyshortcuts="Meta+Shift+F Control+Shift+F"
              onClick={() => changeFocusMode(true)} className="rounded-full p-2 text-muted hover:bg-hover">
              <IconFocus size={16} />
            </button>
          </div>
        )}
      </section>

      {showPreview && (
        <aside aria-label="Live preview" className="flex min-h-0 min-w-0 flex-1 flex-col lg:w-[clamp(340px,40vw,560px)] lg:flex-none lg:border-l lg:border-line">
          <PreviewPanel posts={posts} me={me} numbered={numbered} mobile={mobileDevice} onDeviceChange={setMobileDevice} onClose={closePreview} />
        </aside>
      )}
      </div>

      {commandOpen && active && <CommandBar commands={commands} onClose={() => setCommandOpen(false)} />}
      <ConfirmDialog
        open={confirm === "publish"}
        title={status === "failed" ? "Retry publishing?" : "Publish thread now?"}
        body={
          <>
            {posts.length > 1 ? `${posts.length} posts` : "Your post"} will be published to X as{" "}
            <b className="text-ink">@{me?.username}</b> right away.
            {status === "scheduled" && " This replaces the scheduled time."}
            {estimate > 0 && (
              <>
                {" "}
                Estimated cost: <b className="text-ink">≈ {formatCredits(estimate)} credits</b>
                {isAdmin ? " (unmetered)" : ""}.
              </>
            )}
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

const FAILED_TEXT: Record<string, string> = {
  insufficient_credits: "You ran out of credits before this could post.",
  reconnect_required: "Your X connection expired, so this couldn’t post.",
  credit_cap_reached: "This instance hit its daily credit cap. Try again later.",
  rate_limited: "X rate-limited the request. Try again in a few minutes.",
};

function BuyCreditsButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="shrink-0 rounded-full bg-danger px-3 py-0.5 text-[12.5px] font-bold text-white hover:opacity-90"
    >
      Buy credits
    </button>
  );
}

function FailedReason({ error, balance, onBuy }: { error: string; balance: number | null; onBuy: (() => void) | null }) {
  const { code, message } = parseLastError(error);
  const friendly = code ? FAILED_TEXT[code] : undefined;
  return (
    <div className="mt-0.5 break-words text-[13px] opacity-90">
      {friendly ?? message}
      {code === "insufficient_credits" && (
        <span className="text-muted">
          {" "}
          {balance != null ? `You have ${formatCredits(balance)} credits. ` : ""}Ask the admin for more, then retry.
        </span>
      )}
      {code === "insufficient_credits" && onBuy && (
        <span className="ml-2 inline-flex">
          <BuyCreditsButton onClick={onBuy} />
        </span>
      )}
      {code === "reconnect_required" && (
        <a
          href="/api/auth/login"
          className="ml-2 inline-flex rounded-full bg-danger px-3 py-0.5 text-[12.5px] font-bold text-white hover:opacity-90"
        >
          Reconnect X
        </a>
      )}
      {friendly && message && message !== friendly && (
        <div className="mt-0.5 text-[12px] text-muted">{message}</div>
      )}
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
