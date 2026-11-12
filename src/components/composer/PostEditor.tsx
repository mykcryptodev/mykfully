"use client";

import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MAX_DRAFT_POSTS, MAX_DRAFT_POST_CODE_UNITS } from "@/lib/draft-limits";
import { countPost, hasUrl, overflowIndex, splitIntoThread, tokenize } from "@/lib/text";
import type { Me, ThreadPost, XUser } from "../lib/api";
import { Avatar } from "../ui/Avatar";
import { VerifiedBadge } from "../ui/VerifiedBadge";
import { IconAddPost, IconExternal, IconLink, IconScissors, IconX } from "../ui/icons";
import { CharCounter } from "./CharCounter";
import { MentionMenu } from "./MentionMenu";
import { useMentionSearch } from "./useMentionSearch";
import { findEmoji } from "./emoji";

/** "@abc" immediately before the caret (X handle chars, max 15). */
const MENTION_BEFORE_CARET = /(?:^|[^A-Za-z0-9_@＠!#$%&*/])[@＠]([A-Za-z0-9_]{0,15})$/;
const WORD_AFTER_CARET = /^[A-Za-z0-9_]*/;
const EMOJI_BEFORE_CARET = /(?:^|\s):([a-z0-9_+\-]{1,32})$/i;
const EMOJI_AFTER_CARET = /^[a-z0-9_+\-]*:?/i;
const WRITING_METRICS = { fontSize: "18px", lineHeight: "28px" };
const ACTION_BUTTON = "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent";
const POST_ACTION = "flex w-full items-center justify-between gap-4 rounded-md px-2 py-1.5 text-left text-sm hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent";

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
  displayMode: "social" | "writing";
  showNumber: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  autoFocus?: boolean;
  registerInput: (id: string, el: HTMLTextAreaElement | null) => void;
  onChange: (id: string, text: string) => void;
  onSplitAt: (id: string, before: string, after: string) => void;
  onReplaceWith: (id: string, texts: string[]) => void;
  onRemove: (id: string, focusPrev: boolean) => void;
  onMergeUp: (id: string) => void;
  onFocusSibling: (id: string, dir: -1 | 1) => void;
  onInsertAfter: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
};

function PostEditorImpl({
  post,
  index,
  total,
  me,
  max,
  readOnly: draftReadOnly,
  displayMode,
  showNumber,
  canMoveUp,
  canMoveDown,
  autoFocus,
  registerInput,
  onChange,
  onSplitAt,
  onReplaceWith,
  onRemove,
  onMergeUp,
  onFocusSibling,
  onInsertAfter,
  onMove,
}: Props) {
  const text = post.text;
  const posted = !!post.tweetId;
  const readOnly = draftReadOnly || posted;
  const isLast = index === total - 1;
  const canInsert = total < MAX_DRAFT_POSTS;
  const canAddBelow = !draftReadOnly && canInsert && (!posted || isLast);
  const writing = displayMode === "writing";
  const metrics = writing ? WRITING_METRICS : undefined;

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const markerRef = useRef<HTMLSpanElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const actionsButtonRef = useRef<HTMLButtonElement>(null);
  const actionsId = useId();

  const [focused, setFocused] = useState(false);
  const [mention, setMention] = useState<MentionCtx | null>(null);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [justPasted, setJustPasted] = useState(false);
  const [alias, setAlias] = useState<MentionCtx | null>(null);
  const [dismissedAliasAt, setDismissedAliasAt] = useState<number | null>(null);
  const [aliasIndex, setAliasIndex] = useState(0);
  const [emojiRange, setEmojiRange] = useState<{ start: number; end: number } | null>(null);
  const [emojiQuery, setEmojiQuery] = useState("");
  const [actionsOpen, setActionsOpen] = useState(false);

  const { weighted, valid } = useMemo(() => countPost(text, max), [text, max]);
  const overflowAt = useMemo(() => (valid ? null : overflowIndex(text, max)), [text, max, valid]);
  const containsLink = useMemo(() => hasUrl(text), [text]);
  const splitParts = useMemo(
    () => (canInsert && weighted > max ? splitIntoThread(text, max) : null),
    [canInsert, text, max, weighted],
  );

  const pickerOpen = !!emojiRange && !readOnly;
  const menuOpen = !!mention && mention.query.length > 0 && focused && dismissedAt !== mention.start && !readOnly && !pickerOpen;
  const aliasMatches = useMemo(() => (alias ? findEmoji(alias.query).slice(0, 6) : []), [alias]);
  const aliasOpen = !!alias && aliasMatches.length > 0 && focused && dismissedAliasAt !== alias.start && !readOnly && !pickerOpen;
  const safeAliasIndex = Math.min(aliasIndex, Math.max(0, aliasMatches.length - 1));
  const markerAt = menuOpen ? mention!.start : aliasOpen ? alias!.start : null;
  const pickerMatches = useMemo(() => (pickerOpen ? findEmoji(emojiQuery) : []), [emojiQuery, pickerOpen]);
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

  // Position autocomplete under the active token.
  useLayoutEffect(() => {
    if (markerAt == null || !markerRef.current || !wrapRef.current) {
      setMenuPos(null);
      return;
    }
    const m = markerRef.current;
    const wrapW = wrapRef.current.clientWidth;
    const left = Math.max(0, Math.min(m.offsetLeft - 16, wrapW - 300));
    setMenuPos({ top: m.offsetTop + m.offsetHeight + 6, left });
  }, [markerAt, writing, text]);

  const updateSuggestions = (el: HTMLTextAreaElement) => {
    if (el.selectionStart !== el.selectionEnd) {
      setMention(null);
      setAlias(null);
      return;
    }
    const match = el.value.slice(0, el.selectionStart).match(EMOJI_BEFORE_CARET);
    if (match) {
      const query = match[1];
      const start = el.selectionStart - query.length - 1;
      if (alias?.query !== query || alias.start !== start) {
        setAlias({ start, query });
        setAliasIndex(0);
      }
    } else {
      setAlias(null);
      setDismissedAliasAt(null);
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

  const insertText = (start: number, end: number, insertion: string, newCaret = start + insertion.length) => {
    const el = taRef.current;
    if (!el || readOnly) return;
    const next = el.value.slice(0, start) + insertion + el.value.slice(end);
    if (next.length > MAX_DRAFT_POST_CODE_UNITS) return;
    el.focus();
    el.setSelectionRange(start, end);
    // execCommand keeps the native undo stack; fall back to a controlled update.
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, insertion);
    } catch {
      ok = false;
    }
    if (ok || next === el.value) {
      el.setSelectionRange(newCaret, newCaret);
    } else {
      pendingCaret.current = newCaret;
      onChange(post.id, next);
    }
  };

  const pick = (u: XUser) => {
    const el = taRef.current;
    if (!el || !mention) return;
    const caret = el.selectionStart;
    const tail = el.value.slice(caret).match(WORD_AFTER_CARET)?.[0] ?? "";
    const end = caret + tail.length;
    const after = el.value.slice(end);
    const space = after.startsWith(" ");
    const insertion = `@${u.username}${space ? "" : " "}`;
    insertText(mention.start, end, insertion, mention.start + insertion.length + Number(space));
    setMention(null);
  };

  const pickAlias = (symbol: string) => {
    const el = taRef.current;
    if (!el || !alias) return;
    const caret = el.selectionStart;
    const tail = el.value.slice(caret).match(EMOJI_AFTER_CARET)?.[0] ?? "";
    insertText(alias.start, caret + tail.length, symbol);
    setAlias(null);
  };

  const openEmojiPicker = () => {
    const el = taRef.current;
    if (!el || readOnly) return;
    setEmojiQuery("");
    setEmojiRange({ start: el.selectionStart, end: el.selectionEnd });
  };

  const splitAtCursor = () => {
    const el = taRef.current;
    if (!el || readOnly || !canInsert) return;
    const point = el.selectionStart;
    onSplitAt(post.id, el.value.slice(0, point).trimEnd(), el.value.slice(point).trimStart());
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const el = e.target;
    const value = el.value;
    const caret = el.selectionStart;
    const input = e.nativeEvent as InputEvent;
    const wasPasted = input.inputType === "insertFromPaste";
    // Typefully-style: three consecutive newlines start a new post.
    if (
      canInsert &&
      !wasPasted &&
      !input.isComposing &&
      value.length > text.length &&
      caret >= 3 &&
      value.slice(caret - 3, caret) === "\n\n\n" &&
      el.selectionStart === el.selectionEnd
    ) {
      onSplitAt(post.id, value.slice(0, caret - 3).replace(/\s+$/, ""), value.slice(caret).replace(/^\n+/, ""));
      setMention(null);
      setAlias(null);
      return;
    }
    if (wasPasted) {
      setJustPasted(true);
    } else if (justPasted) setJustPasted(false);
    onChange(post.id, value);
    updateSuggestions(el);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const el = e.currentTarget;
    if (readOnly) return;

    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (canInsert) onInsertAfter(post.id);
        return;
      }
      if (e.code === "Period" && e.shiftKey) {
        e.preventDefault();
        openEmojiPicker();
        return;
      }
    }
    if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const up = e.key === "ArrowUp";
      if (up ? canMoveUp : canMoveDown) {
        e.preventDefault();
        onMove(post.id, up ? -1 : 1);
      }
      return;
    }

    if (aliasOpen && !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setAliasIndex((safeAliasIndex + delta + aliasMatches.length) % aliasMatches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickAlias(aliasMatches[safeAliasIndex].symbol);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setDismissedAliasAt(alias!.start);
        return;
      }
    }

    if (menuOpen && !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
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
      if ((e.key === "Enter" || e.key === "Tab") && users.length) {
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

    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;

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
    () => renderMirror(text, overflowAt, markerAt, markerRef),
    [text, overflowAt, markerAt],
  );

  const listboxId = `mentions-${post.id}`;
  const aliasListId = `emoji-aliases-${post.id}`;

  return (
    <div className={`group/post relative flex gap-2.5 px-4 ${writing ? "pt-4" : "pt-2"}`}>
      <div aria-hidden className={`relative flex shrink-0 flex-col items-center ${writing ? "w-4 pt-2.5" : "w-10"}`}>
        {writing
          ? <span className="h-2 w-2 rounded-full border border-line-strong bg-canvas" />
          : <Avatar src={me?.profileImageUrl} name={me?.name} size={40} />}
        {!isLast && (
          <span className={`absolute -bottom-2 w-0.5 rounded-full bg-line-strong ${writing ? "top-6" : "top-[44px]"}`} />
        )}
      </div>

      <div className="min-w-0 flex-1 pb-1">
        {!writing && (
          <div className="flex items-center gap-1 text-[15px] leading-5">
            <span className="truncate font-bold text-ink">{me?.name ?? " "}</span>
            <VerifiedBadge type={me?.verifiedType} />
            <span className="truncate text-muted">{me ? `@${me.username}` : ""}</span>
          </div>
        )}

        <div ref={wrapRef} className="relative mt-0.5 grid">
          <div aria-hidden style={metrics} className="tweet-text pointer-events-none col-start-1 row-start-1 min-h-5 text-ink">
            {mirror}
            {"​"}
          </div>
          <textarea
            ref={setRefs}
            value={text}
            readOnly={readOnly}
            autoFocus={autoFocus}
            maxLength={MAX_DRAFT_POST_CODE_UNITS}
            rows={1}
            spellCheck
            placeholder={index === 0 ? "Write something…" : "Continue your thread…"}
            aria-label={`Post ${index + 1} of ${total}`}
            role="combobox"
            aria-expanded={menuOpen || aliasOpen}
            aria-controls={menuOpen ? listboxId : aliasOpen ? aliasListId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={menuOpen && users.length
              ? `${listboxId}-${safeActive}`
              : aliasOpen ? `${aliasListId}-${safeAliasIndex}` : undefined}
            style={metrics}
            className="tweet-text composer-input col-start-1 row-start-1 h-full w-full"
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onSelect={(e) => updateSuggestions(e.currentTarget)}
            onFocus={(e) => {
              setFocused(true);
              updateSuggestions(e.currentTarget);
            }}
            onBlur={() => setFocused(false)}
          />
          {menuOpen && menuPos && (
            <MentionMenu
              id={listboxId}
              users={users}
              activeIndex={safeActive}
              loading={search.loading}
              resolved={search.resolved}
              creditsExhausted={search.creditsExhausted}
              query={mention!.query}
              style={{ top: menuPos.top, left: menuPos.left }}
              onHover={setActive}
              onPick={pick}
            />
          )}
          {aliasOpen && menuPos && (
            <ul
              id={aliasListId}
              aria-label="Emoji suggestions"
              role="listbox"
              className="animate-pop absolute z-30 w-[260px] max-w-full rounded-xl border border-line bg-canvas p-1 shadow-pop"
              style={menuPos}
            >
              {aliasMatches.map(({ symbol, name }, i) => (
                <li
                  key={symbol}
                  id={`${aliasListId}-${i}`}
                  role="option"
                  aria-selected={i === safeAliasIndex}
                  onMouseMove={() => setAliasIndex(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickAlias(symbol)}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm text-ink ${i === safeAliasIndex ? "bg-hover" : ""}`}
                >
                  <span aria-hidden className="text-lg">{symbol}</span>
                  <span className="truncate">:{name}:</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-1 flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
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
          {splitParts && splitParts.length > 1 && total - 1 + splitParts.length <= MAX_DRAFT_POSTS && !readOnly && (
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
          {(!readOnly || canAddBelow || (showNumber && total > 1)) && (
            <div
              role="group"
              aria-label={`Tools for post ${index + 1}`}
              className={`ml-auto flex shrink-0 items-center gap-0.5 transition-opacity ${
                showNumber || (!readOnly && max - weighted <= 20)
                  ? ""
                  : "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/post:opacity-100 group-focus-within/post:opacity-100"
              }`}
            >
              {!readOnly && <CharCounter weighted={weighted} max={max} />}
              {total > 1 && (showNumber || !readOnly) && (
                <span className="px-1 text-[13px] tabular-nums text-muted">
                  {showNumber ? `${index + 1}/${total}` : `#${index + 1}`}
                </span>
              )}
              {canAddBelow && (
                <button
                  type="button"
                  onClick={() => onInsertAfter(post.id)}
                  className={ACTION_BUTTON}
                  aria-label="Add post below"
                  aria-keyshortcuts="Meta+Enter Control+Enter"
                  title="Add post below"
                >
                  <IconAddPost size={16} />
                </button>
              )}
              {!readOnly && (
                <div className="relative">
                  <button
                    type="button"
                    className={ACTION_BUTTON}
                    onClick={pickerOpen ? () => setEmojiRange(null) : openEmojiPicker}
                    aria-label="Insert emoji"
                    aria-keyshortcuts="Meta+Shift+. Control+Shift+."
                    aria-expanded={pickerOpen}
                    aria-haspopup="dialog"
                    title="Insert emoji"
                  >
                    <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M8 14a4 4 0 0 0 8 0M9 9h.01M15 9h.01" />
                    </svg>
                  </button>
                  {pickerOpen && (
                    <div
                      role="dialog"
                      aria-label="Emoji picker"
                      className="animate-pop absolute right-0 top-full z-30 mt-1 w-[270px] max-w-[calc(100vw-96px)] rounded-xl border border-line bg-canvas p-2 shadow-pop"
                      onBlur={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget)) setEmojiRange(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.preventDefault();
                          e.stopPropagation();
                          setEmojiRange(null);
                          taRef.current?.focus();
                        }
                      }}
                    >
                      <input
                        type="search"
                        autoFocus
                        aria-label="Search emoji"
                        placeholder="Search emoji…"
                        value={emojiQuery}
                        onChange={(e) => setEmojiQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.nativeEvent.isComposing && pickerMatches.length) {
                            e.preventDefault();
                            insertText(emojiRange.start, emojiRange.end, pickerMatches[0].symbol);
                            setEmojiRange(null);
                          }
                        }}
                        className="mb-1.5 w-full rounded-lg bg-hover px-2 py-1.5 text-sm text-ink outline-none focus-visible:ring-1 focus-visible:ring-accent"
                      />
                      <div className="grid max-h-40 grid-cols-6 gap-0.5 overflow-y-auto">
                        {pickerMatches.map(({ symbol, name }) => (
                          <button
                            type="button"
                            key={symbol}
                            aria-label={name.replaceAll("_", " ")}
                            title={name.replaceAll("_", " ")}
                            className="rounded-md py-0.5 text-lg hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                            onClick={() => {
                              insertText(emojiRange.start, emojiRange.end, symbol);
                              setEmojiRange(null);
                            }}
                          >
                            {symbol}
                          </button>
                        ))}
                      </div>
                      {pickerMatches.length === 0 && <p className="px-2 py-1.5 text-sm text-muted">No matching emoji</p>}
                    </div>
                  )}
                </div>
              )}
              {!readOnly && ((canInsert && text) || total > 1) && (
                <div
                  className="relative"
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) setActionsOpen(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape" || !actionsOpen) return;
                    event.preventDefault();
                    event.stopPropagation();
                    setActionsOpen(false);
                    actionsButtonRef.current?.focus();
                  }}
                >
                  <button
                    ref={actionsButtonRef}
                    type="button"
                    aria-label={`More options for post ${index + 1}`}
                    aria-controls={actionsOpen ? actionsId : undefined}
                    aria-expanded={actionsOpen}
                    className={ACTION_BUTTON}
                    title="More options"
                    onClick={(event) => {
                      event.currentTarget.focus();
                      setActionsOpen((open) => !open);
                    }}
                  >
                    <span aria-hidden className="text-lg leading-none">⋯</span>
                  </button>
                  {actionsOpen && (
                    <div id={actionsId} role="group" aria-label="Post actions" className="animate-pop absolute right-0 top-full z-30 mt-1 w-48 rounded-xl border border-line bg-canvas p-1 shadow-pop">
                      {canInsert && text && (
                        <button type="button" className={POST_ACTION} onClick={() => { setActionsOpen(false); splitAtCursor(); }}>
                          Split at cursor <IconScissors size={14} />
                        </button>
                      )}
                      {canMoveUp && (
                        <button type="button" className={POST_ACTION} aria-keyshortcuts="Alt+ArrowUp" onClick={() => { setActionsOpen(false); onMove(post.id, -1); }}>
                          Move up <kbd className="text-xs text-muted">Alt ↑</kbd>
                        </button>
                      )}
                      {canMoveDown && (
                        <button type="button" className={POST_ACTION} aria-keyshortcuts="Alt+ArrowDown" onClick={() => { setActionsOpen(false); onMove(post.id, 1); }}>
                          Move down <kbd className="text-xs text-muted">Alt ↓</kbd>
                        </button>
                      )}
                      {total > 1 && (
                        <button type="button" className={`${POST_ACTION} text-danger`} onClick={() => onRemove(post.id, index > 0)}>
                          Delete post <IconX size={14} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const PostEditor = memo(PostEditorImpl);
