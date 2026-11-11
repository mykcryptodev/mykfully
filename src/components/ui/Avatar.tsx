/* eslint-disable @next/next/no-img-element -- remote X avatars; no next/image remote config */
"use client";

import { useState } from "react";

export function Avatar({
  src,
  name,
  size = 40,
  className = "",
}: {
  src?: string | null;
  name?: string | null;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const initials = (name || "?")
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const style = { width: size, height: size };
  if (!src || failed) {
    return (
      <div
        style={{ ...style, fontSize: Math.max(10, size * 0.38) }}
        className={`flex shrink-0 select-none items-center justify-center rounded-full bg-accent-soft font-semibold text-accent ${className}`}
        aria-hidden
      >
        {initials}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      style={style}
      className={`shrink-0 rounded-full bg-line object-cover ${className}`}
      onError={() => setFailed(true)}
      draggable={false}
    />
  );
}
