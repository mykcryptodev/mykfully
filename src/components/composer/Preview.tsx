"use client";

import { tokenize } from "@/lib/text";
import type { Me, ThreadPost } from "../lib/api";
import { Avatar } from "../ui/Avatar";
import { VerifiedBadge } from "../ui/VerifiedBadge";
import { XBookmark, XLike, XReply, XRepost, XShare, XViews } from "../ui/icons";

function Linkified({ text }: { text: string }) {
  return (
    <>
      {tokenize(text).map((t) => {
        if (t.type === "text") return <span key={t.start}>{t.text}</span>;
        let href = "#";
        if (t.type === "mention") href = `https://x.com/${t.value}`;
        else if (t.type === "hashtag") href = `https://x.com/hashtag/${t.value}`;
        else if (t.type === "cashtag") href = `https://x.com/search?q=%24${t.value}`;
        else if (t.type === "url") href = /^https?:\/\//i.test(t.text) ? t.text : `https://${t.text}`;
        let label = t.text;
        if (t.type === "url") {
          const bare = t.text.replace(/^https?:\/\/(www\.)?/i, "");
          label = bare.length > 30 ? `${bare.slice(0, 29)}…` : bare;
        }
        return (
          <a key={t.start} href={href} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            {label}
          </a>
        );
      })}
    </>
  );
}

const ACTIONS = [
  { Icon: XReply, label: "Reply", hover: "group-hover/a:text-accent group-hover/a:bg-accent/10" },
  { Icon: XRepost, label: "Repost", hover: "group-hover/a:text-success group-hover/a:bg-success/10" },
  { Icon: XLike, label: "Like", hover: "group-hover/a:text-[#f91880] group-hover/a:bg-[#f91880]/10" },
  { Icon: XViews, label: "View", hover: "group-hover/a:text-accent group-hover/a:bg-accent/10" },
];

/** Read-only rendering of the thread as it would appear on X. */
export function Preview({ posts, me, numbered }: { posts: ThreadPost[]; me: Me | null; numbered: boolean }) {
  return (
    <div className="font-tweet">
      {posts.map((p, i) => {
        const last = i === posts.length - 1;
        return (
          <article key={p.id} className="relative flex gap-3 px-4 pt-3 transition-colors hover:bg-hover/40">
            <div className="relative flex w-10 shrink-0 flex-col items-center">
              <Avatar src={me?.profileImageUrl} name={me?.name} size={40} />
              {!last && <div className="absolute bottom-[-12px] top-[44px] w-0.5 bg-line-strong" />}
            </div>
            <div className="min-w-0 flex-1 pb-3">
              <div className="flex items-center gap-1 text-[15px] leading-5">
                <span className="truncate font-bold text-ink hover:underline">{me?.name}</span>
                <VerifiedBadge type={me?.verifiedType} />
                <span className="truncate text-muted">@{me?.username}</span>
                <span className="text-muted">·</span>
                <span className="shrink-0 text-muted hover:underline">now</span>
              </div>
              <div className="tweet-text mt-0.5 text-ink">
                {p.text.trim() ? (
                  <Linkified text={p.text} />
                ) : (
                  <span className="italic text-muted">Empty post</span>
                )}
                {numbered && posts.length > 1 && (
                  <span className="text-ink">
                    {"\n"}
                    {i + 1}/{posts.length}
                  </span>
                )}
              </div>
              <div className="-ml-2 mt-1 flex max-w-[425px] items-center justify-between text-muted">
                {ACTIONS.map(({ Icon, label, hover }) => (
                  <span key={label} className="group/a flex items-center" aria-label={label}>
                    <span className={`rounded-full p-2 transition-colors ${hover}`}>
                      <Icon />
                    </span>
                  </span>
                ))}
                <span className="flex items-center">
                  <span className="rounded-full p-2 hover:bg-accent/10 hover:text-accent">
                    <XBookmark />
                  </span>
                  <span className="rounded-full p-2 hover:bg-accent/10 hover:text-accent">
                    <XShare />
                  </span>
                </span>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
