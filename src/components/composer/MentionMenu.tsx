"use client";

import { useEffect, useRef } from "react";
import type { XUser } from "../lib/api";
import { Avatar } from "../ui/Avatar";
import { VerifiedBadge } from "../ui/VerifiedBadge";
import { Spinner } from "../ui/Spinner";

export function MentionMenu({
  id,
  users,
  activeIndex,
  loading,
  resolved,
  creditsExhausted,
  query,
  style,
  onHover,
  onPick,
}: {
  id: string;
  users: XUser[];
  activeIndex: number;
  loading: boolean;
  resolved: boolean;
  creditsExhausted?: boolean;
  query: string;
  style: React.CSSProperties;
  onHover: (i: number) => void;
  onPick: (u: XUser) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      className="animate-pop absolute z-30 w-[300px] max-w-[calc(100vw-32px)] overflow-hidden rounded-xl bg-canvas shadow-pop"
      style={style}
      onMouseDown={(e) => e.preventDefault()}
    >
      <ul id={id} role="listbox" ref={listRef} className="max-h-[300px] overflow-y-auto py-1">
        {users.map((u, i) => (
          <li
            key={u.id}
            id={`${id}-${i}`}
            data-index={i}
            role="option"
            aria-selected={i === activeIndex}
            onMouseMove={() => i !== activeIndex && onHover(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(u);
            }}
            className={`flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors ${
              i === activeIndex ? "bg-hover" : ""
            }`}
          >
            <Avatar src={u.profileImageUrl} name={u.name} size={40} />
            <div className="min-w-0 flex-1 leading-5">
              <div className="flex items-center gap-0.5">
                <span className="truncate text-[15px] font-bold text-ink">{u.name}</span>
                <VerifiedBadge type={u.verifiedType} size={18} />
              </div>
              <div className="truncate text-[15px] text-muted">@{u.username}</div>
            </div>
          </li>
        ))}
        {users.length === 0 && (loading || !resolved) && (
          <li className="flex items-center justify-center py-5 text-accent">
            <Spinner size={22} />
          </li>
        )}
        {users.length === 0 && !loading && resolved && (
          <li className="px-4 py-4 text-[15px] text-muted">
            No accounts match <span className="text-ink">@{query}</span>
          </li>
        )}
      </ul>
      {creditsExhausted && (
        <div className="border-t border-line px-4 py-2 text-[12.5px] text-muted">
          Out of credits — showing recent mentions only
        </div>
      )}
      {users.length > 0 && loading && (
        <div className="pointer-events-none absolute right-3 top-3 text-accent">
          <Spinner size={14} />
        </div>
      )}
    </div>
  );
}
