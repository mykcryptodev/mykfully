"use client";

import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { countPost, hasUrl, overflowIndex, splitIntoThread, tokenize } from "@/lib/text";
import type { Me, ThreadPost, XUser } from "../lib/api";
import { Avatar } from "../ui/Avatar";
import { VerifiedBadge } from "../ui/VerifiedBadge";
import { IconExternal, IconLink, IconPlus, IconScissors, IconX } from "../ui/icons";
import { CharCounter } from "./CharCounter";
import { MentionMenu } from "./MentionMenu";
import { useMentionSearch } from "./useMentionSearch";

/** "@abc" immediately before the caret (X handle chars, max 15). */
const MENTION_BEFORE_CARET = /(?:^|[^A-Za-z0-9_@＠!#$%&*/])[@＠]([A-Za-z0-9_]{0,15})$/;
const WORD_AFTER_CARET = /^[A-Za-z0-9_]*/;

type MentionCtx = { start: number; query: string };

function findMention(text: string, caret: number): MentionCtx | null {
  const m = text.slice(0, caret).match(MENTION_BEFORE_CARET);
  if (!m) return null;
  return { start: caret - m[1].length - 1, query: m[1] };
}

/** Mirror content: entity highlighting, overflow highlighting and an optional caret marker. */
function renderMirror(
  text: string,
  overflowAt: number | null,
  markerAt: number | null,
  markerRef: React.RefObject<HTMLSpanElement | null>,
): ReactNode[] {
  const tokens = tokenize(text);
  const cuts = new Set<number>([0, text.length]);
  for (const t of tokens) {
    cuts.add(t.start);
    cuts.add(t.end);
  }
  if (overflowAt != null) cuts.add(Math.min(overflowAt, text.length));
  if (markerAt != null) {
    cuts.add(markerAt);
    cuts.add(Math.min(markerAt + 1, text.length));
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const out: ReactNode[] = [];
  let ti = 0;
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    const e = sorted[i + 1];
    if (e === undefined || e <= s) continue;
    while (ti < tokens.length - 1 && tokens[ti].end <= s) ti++;
    const tok = tokens[ti];
    const entity = tok && tok.type !== "text" && s >= tok.start && e <= tok.end;
    const over = overflowAt != null && s >= overflowAt;
    const cls = `${entity ? "text-accent" : ""} ${over ? "bg-danger/25 rounded-[2px]" : ""}`.trim();
    const chunk = text.slice(s, e);
    if (markerAt === s) {
      // Wrap the "@" itself so the marker sits on the same line as the token (soft wraps).
      out.push(
        <span key={s} ref={markerRef} className={cls || undefined}>
          {chunk}
        </span>,
      );
      continue;
    }
    out.push(
      cls ? (
        <span key={s} className={cls}>
          {chunk}
        </span>
      ) : (
        chunk
      ),
    );
  }
  return out;
}

export type PostEditorHandle = { focus: (pos: "start" | "end" | number) => void };

type Props = {
  post: ThreadPost;
  index: number;
  total: number;
  me: Me | null;
  max: number;
  readOnly: boolean;
  showNumber: boolean;
  autoFocus?: boolean;
  registerInput: (id: string, el: HTMLTextAreaElement | null) => void;
  onChange: (id: string, text: string) => void;
  onSplitAt: (id: string, before: string, after: string) => void;
  onReplaceWith: (id: string, texts: string[]) => void;
  onRemove: (id: string, focusPrev: boolean) => void;
  onMergeUp: (id: string) => void;
  onFocusSibling: (id: string, dir: -1 | 1) => void;
  onInsertAfter: (id: string) => void;
};

function PostEditorImpl({
  post,
  index,
  total,
  me,
  max,
  readOnly: draftReadOnly,
  showNumber,
  autoFocus,
  registerInput,
  onChange,
  onSplitAt,
  onReplaceWith,
  onRemove,
  onMergeUp,
  onFocusSibling,
  onInsertAfter,
}: Props) {
  const text = post.text;
  const posted = !!post.tweetId;
  const readOnly = draftReadOnly || posted;
  const isLast = index === total - 1;

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const markerRef = useRef<HTMLSpanElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const pastedRef = useRef(false);

  const [focused, setFocused] = useState(false);
  const [mention, setMention] = useState<MentionCtx | null>(null);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [justPasted, setJustPasted] = useState(false);

  const { weighted, valid } = useMemo(() => countPost(text, max), [text, max]);
  const overflowAt = useMemo(() => (valid ? null : overflowIndex(text, max)), [text, max, valid]);
  const containsLink = useMemo(() => hasUrl(text), [text]);
  const splitParts = useMemo(
    () => (weighted > max ? splitIntoThread(text, max) : null),
    [text, max, weighted],
  );

  const menuOpen = !!mention && mention.query.length > 0 && focused && dismissedAt !== mention.start && !readOnly;
  const search = useMentionSearch(menuOpen ? mention!.query : null);
  const users = search.users;

  // keep active index in range when results change
  const safeActive = users.length ? Math.min(active, users.length - 1) : 0;

  const setRefs = useCallback(
    (el: HTMLTextAreaElement | null) => {
      taRef.current = el;
      registerInput(post.id, el);
    },
    [registerInput, post.id],
  );

  // restore caret after programmatic text changes
  useLayoutEffect(() => {
    if (pendingCaret.current != null && taRef.current) {
      const p = pendingCaret.current;
      pendingCaret.current = null;
      taRef.current.setSelectionRange(p, p);
    }
  }, [text]);

  // position the dropdown under the "@" token
  useLayoutEffect(() => {
    if (!menuOpen || !markerRef.current || !wrapRef.current) {
      setMenuPos(null);
      return;
    }
    const m = markerRef.current;
    const wrapW = wrapRef.current.clientWidth;
    const left = Math.max(0, Math.min(m.offsetLeft - 16, wrapW - 300));
    setMenuPos({ top: m.offsetTop + 24, left });
  }, [menuOpen, mention?.start, text]);

  const updateMention = (el: HTMLTextAreaElement) => {
    if (el.selectionStart !== el.selectionEnd) {
      setMention(null);
      return;
    }
    const ctx = findMention(el.value, el.selectionStart);
    if (!ctx) {
      if (mention) setMention(null);
      setDismissedAt(null);
      return;
    }
    if (!mention || mention.query !== ctx.query) setActive(0);
    if (!mention || mention.start !== ctx.start || mention.query !== ctx.query) setMention(ctx);
  };

  const pick = (u: XUser) => {
    const el = taRef.current;
    if (!el || !mention) return;
    const caret = el.selectionStart;
    const tail = el.value.slice(caret).match(WORD_AFTER_CARET)?.[0] ?? "";
    const end = caret + tail.length;
    const after = el.value.slice(end);
    const insertion = `@${u.username}${after.startsWith(" ") ? "" : " "}`;
    const newCaret = mention.start + insertion.length + (after.startsWith(" ") ? 1 : 0);
    el.focus();
    el.setSelectionRange(mention.start, end);
    // execCommand keeps the native undo stack; fall back to a controlled update.
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, insertion);
    } catch {
      ok = false;
    }
    if (ok) {
      el.setSelectionRange(newCaret, newCaret);
    } else {
      pendingCaret.current = newCaret;
      onChange(post.id, el.value.slice(0, mention.start) + insertion + after);
    }
    setMention(null);
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const el = e.target;
    const value = el.value;
    const caret = el.selectionStart;
    // Typefully-style: three consecutive newlines start a new post.
    if (
      value.length > text.length &&
      caret >= 3 &&
      value.slice(caret - 3, caret) === "\n\n\n" &&
      el.selectionStart === el.selectionEnd
    ) {
      onSplitAt(post.id, value.slice(0, caret - 3).replace(/\s+$/, ""), value.slice(caret).replace(/^\n+/, ""));
      setMention(null);
      return;
    }
    if (pastedRef.current) {
      pastedRef.current = false;
      setJustPasted(true);
    } else if (justPasted) setJustPasted(false);
    onChange(post.id, value);
    updateMention(el);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const el = e.currentTarget;

    if (menuOpen) {
      if (e.key === "ArrowDown" && users.length) {
        e.preventDefault();
        setActive((safeActive + 1) % users.length);
        return;
      }
      if (e.key === "ArrowUp" && users.length) {
        e.preventDefault();
        setActive((safeActive - 1 + users.length) % users.length);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.metaKey && !e.ctrlKey && !e.shiftKey && users.length) {
        e.preventDefault();
        pick(users[safeActive]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setDismissedAt(mention!.start);
        return;
      }
    }

    if (readOnly) return;

    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const s = el.selectionStart;
      const eIdx = el.selectionEnd;
      onSplitAt(post.id, el.value.slice(0, s).replace(/\s+$/, ""), el.value.slice(eIdx).replace(/^\s+/, ""));
      return;
    }

    const collapsed = el.selectionStart === el.selectionEnd;
    if (e.key === "Backspace" && collapsed && el.selectionStart === 0) {
      if (el.value === "" && total > 1) {
        e.preventDefault();
        onRemove(post.id, index > 0);
        return;
      }
      if (index > 0 && el.value !== "") {
        e.preventDefault();
        onMergeUp(post.id);
        return;
      }
    }
    if (e.key === "ArrowUp" && collapsed && el.selectionStart === 0 && index > 0) {
      e.preventDefault();
      onFocusSibling(post.id, -1);
      return;
    }
    if (e.key === "ArrowDown" && collapsed && el.selectionStart === el.value.length && !isLast) {
      e.preventDefault();
      onFocusSibling(post.id, 1);
    }
  };

  const mirror = useMemo(
    () => renderMirror(text, overflowAt, menuOpen ? mention!.start : null, markerRef),
    [text, overflowAt, menuOpen, mention],
  );

  const listboxId = `mentions-${post.id}`;

  return (
    <div className="group/post relative flex gap-3 px-4 pt-3">
      {/* avatar column + thread connector */}
      <div className="relative flex w-10 shrink-0 flex-col items-center">
        <Avatar src={me?.profileImageUrl} name={me?.name} size={40} />
        {!isLast && <div className="absolute bottom-[-12px] top-[44px] w-0.5 rounded-full bg-line-strong" />}
      </div>

      <div className="min-w-0 flex-1 pb-3">
        <div className="flex items-center gap-1 text-[15px] leading-5">
          <span className="truncate font-bold text-ink">{me?.name ?? " "}</span>
          <VerifiedBadge type={me?.verifiedType} />
          <span className="truncate text-muted">{me ? `@${me.username}` : ""}</span>
          <span className="flex-1" />
          {showNumber && total > 1 && (
            <span className="text-[13px] tabular-nums text-muted">
              {index + 1}/{total}
            </span>
          )}
          {!readOnly && total > 1 && (
            <button
              onClick={() => onRemove(post.id, index > 0)}
              className="-my-1 rounded-full p-1 text-muted opacity-0 transition hover:bg-danger/10 hover:text-danger focus:opacity-100 group-hover/post:opacity-100"
              aria-label={`Remove post ${index + 1}`}
              title="Remove post"
            >
              <IconX size={15} />
            </button>
          )}
        </div>

        <div ref={wrapRef} className="relative mt-0.5 grid">
          <div aria-hidden className="tweet-text pointer-events-none col-start-1 row-start-1 min-h-5 text-ink">
            {mirror}
            {"​"}
          </div>
          <textarea
            ref={setRefs}
            value={text}
            readOnly={readOnly}
            autoFocus={autoFocus}
            rows={1}
            spellCheck
            placeholder={index === 0 ? "What’s happening?" : "Add another post"}
            aria-label={`Post ${index + 1} of ${total}`}
            role="combobox"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? listboxId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={menuOpen && users.length ? `${listboxId}-${safeActive}` : undefined}
            className="tweet-text composer-input col-start-1 row-start-1 h-full w-full"
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onSelect={(e) => updateMention(e.currentTarget)}
            onFocus={(e) => {
              setFocused(true);
              updateMention(e.currentTarget);
            }}
            onBlur={() => setFocused(false)}
            onPaste={() => (pastedRef.current = true)}
          />
          {menuOpen && menuPos && (
            <MentionMenu
              id={listboxId}
              users={users}
              activeIndex={safeActive}
              loading={search.loading}
              resolved={search.resolved}
              query={mention!.query}
              style={{ top: menuPos.top, left: menuPos.left }}
              onHover={setActive}
              onPick={pick}
            />
          )}
        </div>

        {/* footer: hints, split action, counter */}
        <div
          className={`mt-2 flex min-h-[30px] items-center gap-2 transition-opacity ${
            focused || !valid || weighted > max - 20 || posted ? "opacity-100" : "opacity-0 group-hover/post:opacity-100"
          }`}
        >
          {posted && me && (
            <a
              href={`https://x.com/${me.username}/status/${post.tweetId}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline"
            >
              View on X <IconExternal size={13} />
            </a>
          )}
          {containsLink && !posted && (
            <span
              className="inline-flex items-center gap-1 text-[12px] text-muted"
              title="The X API bills posts that contain a URL at a higher rate."
            >
              <IconLink size={12} /> Contains a link (higher X API cost)
            </span>
          )}
          <span className="flex-1" />
          {splitParts && splitParts.length > 1 && !readOnly && (
            <button
              onClick={() => onReplaceWith(post.id, splitParts)}
              className={`inline-flex h-7 items-center gap-1.5 rounded-full border border-accent/40 px-3 text-[13px] font-bold text-accent transition-colors hover:bg-accent-soft ${
                justPasted ? "animate-pulse" : ""
              }`}
              title="Split at paragraph and sentence boundaries"
            >
              <IconScissors size={14} /> Split into {splitParts.length} posts
            </button>
          )}
          {!readOnly && <CharCounter weighted={weighted} max={max} />}
        </div>
      </div>

      {/* "+" between posts */}
      {!draftReadOnly && !isLast && (
        <button
          onClick={() => onInsertAfter(post.id)}
          className="absolute -bottom-3 left-[27px] z-10 flex h-6 w-6 items-center justify-center rounded-full border border-line-strong bg-canvas text-muted opacity-0 shadow-sm transition hover:border-accent hover:text-accent focus:opacity-100 group-hover/post:opacity-100"
          aria-label="Insert post below"
          title="Insert post below"
        >
          <IconPlus size={14} strokeWidth={2.4} />
        </button>
      )}
    </div>
  );
}

export const PostEditor = memo(PostEditorImpl);
