"use client";

import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { maxLengthFor, overflowIndex, STANDARD_MAX, tokenize } from "@/lib/text";
import type { Me, ThreadPost } from "../lib/api";
import { Avatar } from "../ui/Avatar";
import { VerifiedBadge } from "../ui/VerifiedBadge";
import { IconX, XBookmark, XLike, XReply, XRepost, XShare, XViews } from "../ui/icons";
import { PostMedia } from "./PostMedia";

const MOBILE_WIDTH = 393;
const ACTIONS = [
  { id: "reply", Icon: XReply },
  { id: "repost", Icon: XRepost },
  { id: "like", Icon: XLike },
  { id: "views", Icon: XViews },
  { id: "bookmark", Icon: XBookmark },
  { id: "share", Icon: XShare },
];
const DEVICES = ["Desktop", "Mobile"] as const;
type Device = (typeof DEVICES)[number];
type PreviewProps = { posts: ThreadPost[]; me: Me | null; numbered: boolean };

function Linkified({ text }: { text: string }) {
  return tokenize(text).map((token) => {
    if (token.type === "text") return <span key={token.start}>{token.text}</span>;

    const value = encodeURIComponent(token.value ?? "");
    let href: string;
    let label = token.text;
    switch (token.type) {
      case "mention":
        href = `https://x.com/${value}`;
        break;
      case "hashtag":
        href = `https://x.com/hashtag/${value}`;
        break;
      case "cashtag":
        href = `https://x.com/search?q=%24${value}`;
        break;
      case "url": {
        href = /^https?:\/\//i.test(token.text) ? token.text : `https://${token.text}`;
        const bare = token.text.replace(/^(?:https?:\/\/)?(?:www\.)?/i, "");
        const characters = Array.from(bare);
        label = characters.length > 30 ? `${characters.slice(0, 29).join("")}…` : bare;
        break;
      }
    }
    return (
      <a key={token.start} href={href} target="_blank" rel="noreferrer" className="text-accent hover:underline">
        {label}
      </a>
    );
  });
}

const PreviewPost = memo(function PreviewPost({
  post, me, last, number,
}: { post: ThreadPost; me: Me | null; last: boolean; number?: string }) {
  const [expanded, setExpanded] = useState(false);
  const longPostsEnabled = maxLengthFor(me?.verifiedType) > STANDARD_MAX;
  const text = post.text.trim();
  const collapsedText = useMemo(() => {
    if (!longPostsEnabled) return null;
    // Match the normalization used by twitter-text before slicing at its cutoff.
    const normalized = text.normalize();
    const overflow = overflowIndex(normalized);
    if (overflow === null) return null;
    const entity = tokenize(normalized).find(
      (token) => token.type !== "text" && token.start < overflow && token.end > overflow,
    );
    return normalized.slice(0, entity?.start ?? overflow).trimEnd();
  }, [longPostsEnabled, text]);
  const shownText = expanded ? text : collapsedText ?? text;

  return (
    <article className="flex gap-3 px-4 pt-3">
      <div className="relative flex w-10 shrink-0 flex-col items-center">
        <Avatar src={me?.profileImageUrl} name={me?.name} size={40} />
        {!last && <div aria-hidden className="absolute -bottom-3 top-11 w-0.5 rounded-full bg-line-strong" />}
      </div>
      <div className="min-w-0 flex-1 pb-3">
        <div className="flex items-center gap-1 text-[15px] leading-5">
          <span className="truncate font-bold text-ink">{me?.name ?? "Your account"}</span>
          <VerifiedBadge type={me?.verifiedType} size={16} />
          {me && <span className="truncate text-muted">@{me.username}</span>}
          <span aria-hidden className="text-muted">·</span>
          <span className="shrink-0 text-muted">now</span>
          {number && <span className="ml-auto shrink-0 pl-1 text-xs tabular-nums text-muted">{number}</span>}
        </div>
        {(text || !post.media?.length) && (
          <div className="tweet-text mt-0.5 text-ink">
            {text ? <Linkified text={shownText} /> : <span className="italic text-muted">Empty post</span>}
          </div>
        )}
        {collapsedText !== null && (
          <button
            type="button"
            aria-expanded={expanded}
            className="text-[15px] text-accent hover:underline"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
        <PostMedia media={post.media} />
        <div aria-hidden className="mt-3 flex max-w-[425px] items-center justify-between text-muted">
          {ACTIONS.map(({ id, Icon }) => <Icon key={id} size={17} />)}
        </div>
      </div>
    </article>
  );
});

/** A live X preview that keeps mobile line wraps stable as the sidebar changes width. */
export function PreviewPanel({
  posts, me, numbered, mobile, onDeviceChange, onClose,
}: PreviewProps & {
  mobile: boolean;
  onDeviceChange: (mobile: boolean) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const device: Device = mobile ? "Mobile" : "Desktop";
  const [scale, setScale] = useState(1);

  useEffect(() => {
    if (!mobile || !viewport.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (width > 0) setScale(Math.min(1, width / MOBILE_WIDTH));
    });
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [mobile]);

  return (
    <section aria-labelledby={titleId} className="flex min-h-0 min-w-0 flex-1 flex-col bg-sidebar">
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-line bg-canvas px-3">
        <h2 id={titleId} className="mr-auto text-sm font-semibold text-ink">X preview</h2>
        <div role="group" aria-label="Preview device" className="flex rounded-lg bg-hover p-0.5">
          {DEVICES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={device === option}
              className={`rounded-md px-2 py-1 text-xs font-medium ${device === option ? "bg-canvas text-ink shadow-xs" : "text-muted hover:text-ink"}`}
              onClick={() => onDeviceChange(option === "Mobile")}
            >
              {option}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label="Close preview"
          title="Close preview"
          className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-ink"
          onClick={onClose}
        >
          <IconX size={17} />
        </button>
      </header>
      <div className={`min-h-0 flex-1 overflow-y-auto overflow-x-hidden ${mobile ? "px-3 py-4" : "bg-canvas"}`}>
        {mobile && <p className="mb-3 text-center text-xs tabular-nums text-muted">393 × 852</p>}
        <div ref={viewport} className="flex min-w-0 justify-center">
          <div
            className={`w-full max-w-[600px] shrink-0 overflow-hidden bg-canvas font-tweet ${mobile ? "rounded-2xl border border-line" : ""}`}
            style={mobile ? { width: MOBILE_WIDTH, maxWidth: "none", zoom: scale } : undefined}
          >
            <div aria-hidden className="border-b border-line text-center">
              <div className="py-3 text-2xl leading-none text-ink">𝕏</div>
              <div className="grid grid-cols-2 text-sm font-semibold">
                <div><span className="inline-block border-b-3 border-accent px-1 pb-2">For you</span></div>
                <div className="text-muted">Following</div>
              </div>
            </div>
            {posts.map((post, index) => (
              <PreviewPost
                key={post.id}
                post={post}
                me={me}
                last={index === posts.length - 1}
                number={numbered && posts.length > 1 ? `${index + 1}/${posts.length}` : undefined}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
