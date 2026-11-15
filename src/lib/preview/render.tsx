/** @jsxRuntime automatic */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ReactNode } from "react";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { maxLengthFor, overflowIndex, STANDARD_MAX, tokenize } from "../text";
import { loadAdditionalAsset } from "./assets";

/**
 * Server-side PNG of a thread as it would look on X, for agents (MCP `preview_draft`).
 * Mirrors src/components/composer/Preview.tsx (the in-app preview): same colors, metrics and URL shortening.
 * Rendered with satori (JSX → SVG, height from content) and resvg (SVG → PNG at 2x).
 */

export type PreviewDevice = "mobile" | "desktop";
export type PreviewTheme = "light" | "dark";

export type PreviewMedia =
  | { kind: "image"; dataUri: string; width: number; height: number; altText?: string; badge?: string }
  | { kind: "video" | "gif" | "unavailable"; width?: number; height?: number; altText?: string };

export type PreviewPost = { text: string; media?: PreviewMedia[] };

export type PreviewAuthor = {
  name: string;
  username: string;
  verifiedType: string | null;
  /** data: URI (already fetched server-side) or null for the initial-letter fallback. */
  avatar: string | null;
};

export type PreviewInput = {
  author: PreviewAuthor;
  posts: PreviewPost[];
  device: PreviewDevice;
  theme: PreviewTheme;
  numbered: boolean;
  /** Index of posts[0] within the whole thread (for "n/N" numbering when paging). */
  offset?: number;
  total?: number;
  /** Number of thread posts after the rendered ones (shown as a footer). */
  remaining?: number;
};

export const DEVICE_WIDTH: Record<PreviewDevice, number> = { mobile: 393, desktop: 600 };
const SCALE = 2;

const THEMES = {
  light: { canvas: "#ffffff", ink: "#0f1419", muted: "#536471", line: "#eff3f4", lineStrong: "#cfd9de", accent: "#1d9bf0", tile: "#f7f9f9" },
  dark: { canvas: "#000000", ink: "#e7e9ea", muted: "#71767b", line: "#2f3336", lineStrong: "#333639", accent: "#1d9bf0", tile: "#16181c" },
} as const;
type Palette = (typeof THEMES)[PreviewTheme];

const BADGE: Record<string, string> = { blue: "#1d9bf0", premium: "#1d9bf0", business: "#e2b719", government: "#829aab" };

/** Paths copied from src/components/ui/icons.tsx (reply, repost, like, views, bookmark, share). */
const ICONS = [
  "M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01zm8.005-6c-3.317 0-6.005 2.69-6.005 6 0 3.37 2.77 6.08 6.138 6.01l.351-.01h1.761v2.3l5.087-2.81c1.951-1.08 3.163-3.13 3.163-5.36 0-3.39-2.744-6.13-6.129-6.13H9.756z",
  "M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z",
  "M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z",
  "M8.75 21V3h2v18h-2zM18 21V8.5h2V21h-2zM4 21l.004-10h2L6 21H4zm9.248 0v-7h2v7h-2z",
  "M4 4.5C4 3.12 5.119 2 6.5 2h11C18.881 2 20 3.12 20 4.5v18.44l-8-5.71-8 5.71V4.5zM6.5 4c-.276 0-.5.22-.5.5v14.56l6-4.29 6 4.29V4.5c0-.28-.224-.5-.5-.5h-11z",
  "M12 2.59l5.7 5.7-1.41 1.42L13 6.41V16h-2V6.41l-3.3 3.3-1.41-1.42L12 2.59zM21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21 3 19.88 3 18.5V15h2v3.5c0 .28.22.5.5.5h12.98c.28 0 .5-.22.5-.5L19 15h2z",
];

let fontsPromise: Promise<{ name: string; data: Buffer; weight: 400 | 700; style: "normal" }[]> | null = null;

/** Inter (SIL OFL 1.1, see fonts/OFL-LICENSE.txt), vendored so the serverless bundle has it (next.config `outputFileTracingIncludes`). */
function loadFonts() {
  fontsPromise ??= (async () => {
    const dir = path.join(process.cwd(), "src", "lib", "preview", "fonts");
    const files: [string, 400 | 700][] = [
      ["inter-latin-400-normal.woff", 400],
      ["inter-latin-700-normal.woff", 700],
      ["inter-latin-ext-400-normal.woff", 400],
      ["inter-latin-ext-700-normal.woff", 700],
    ];
    return Promise.all(
      files.map(async ([f, weight]) => ({ name: "Inter", data: await readFile(path.join(dir, f)), weight, style: "normal" as const })),
    );
  })().catch((e) => {
    fontsPromise = null;
    throw e;
  });
  return fontsPromise;
}

/** URL label as X shows it: no scheme/www, max 30 chars with an ellipsis (same as the in-app preview). */
export function urlLabel(text: string): string {
  const bare = text.replace(/^(?:https?:\/\/)?(?:www\.)?/i, "");
  const chars = Array.from(bare);
  return chars.length > 30 ? `${chars.slice(0, 29).join("")}…` : bare;
}

function RichText({ text, c }: { text: string; c: Palette }) {
  return (
    <>
      {tokenize(text).map((t) =>
        t.type === "text" ? (
          <span key={t.start}>{t.text}</span>
        ) : (
          <span key={t.start} style={{ color: c.accent }}>
            {t.type === "url" ? urlLabel(t.text) : t.text}
          </span>
        ),
      )}
    </>
  );
}

function Badge({ type }: { type: string | null }) {
  if (!type || type === "none") return null;
  return (
    <svg viewBox="0 0 22 22" width={16} height={16} style={{ marginLeft: 2, flexShrink: 0 }}>
      <path
        fill={BADGE[type] ?? "#1d9bf0"}
        d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816z"
      />
      <path fill="#fff" d="M9.585 14.929l-3.28-3.28 1.168-1.168 2.112 2.112 5.296-5.296 1.168 1.168z" />
    </svg>
  );
}

function Avatar({ author, c }: { author: PreviewAuthor; c: Palette }) {
  if (author.avatar) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={author.avatar} width={40} height={40} style={{ borderRadius: 9999 }} alt="" />;
  }
  return (
    <div
      style={{
        display: "flex", width: 40, height: 40, borderRadius: 9999, background: c.lineStrong, color: c.ink,
        alignItems: "center", justifyContent: "center", fontSize: 17, fontWeight: 700,
      }}
    >
      {(Array.from(author.name.trim())[0] ?? "?").toUpperCase()}
    </div>
  );
}

function MediaTile({ m, w, h, c }: { m: PreviewMedia; w: number; h: number; c: Palette }) {
  if (m.kind === "image") {
    return (
      <div style={{ display: "flex", position: "relative", width: w, height: h }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={m.dataUri} width={w} height={h} style={{ objectFit: "cover" }} alt="" />
        {m.badge ? (
          <div style={{ display: "flex", position: "absolute", left: 8, bottom: 8, padding: "1px 5px", borderRadius: 4, background: "rgba(0,0,0,0.77)", color: "#fff", fontSize: 13, fontWeight: 700 }}>
            {m.badge}
          </div>
        ) : null}
      </div>
    );
  }
  const label = m.kind === "video" ? "Video" : m.kind === "gif" ? "GIF" : "Media";
  return (
    <div style={{ display: "flex", width: w, height: h, background: c.tile, alignItems: "center", justifyContent: "center", flexDirection: "column", color: c.muted, fontSize: 13 }}>
      {m.kind === "video" || m.kind === "gif" ? (
        <svg viewBox="0 0 24 24" width={44} height={44}>
          <circle cx="12" cy="12" r="12" fill={c.accent} />
          <path d="M9.5 7.5v9l7-4.5z" fill="#fff" />
        </svg>
      ) : null}
      <span style={{ marginTop: 6 }}>{label}</span>
    </div>
  );
}

/** X's media grid: 1 = full width (aspect-aware), 2 = side by side, 3 = one tall + two stacked, 4 = 2x2. */
function MediaGrid({ media, width, c }: { media: PreviewMedia[]; width: number; c: Palette }) {
  const gap = 2;
  const n = media.length;
  let body: ReactNode;
  let height: number;
  if (n === 1) {
    const m = media[0];
    const ratio = m.width && m.height ? m.height / m.width : 9 / 16;
    height = Math.round(Math.min(Math.max(width * ratio, width * 0.5), width * 1.25));
    body = <MediaTile m={m} w={width} h={height} c={c} />;
  } else {
    height = Math.round((width * 9) / 16);
    const half = (width - gap) / 2;
    const halfH = (height - gap) / 2;
    const col = (items: PreviewMedia[], h: number) => (
      <div style={{ display: "flex", flexDirection: "column", gap }}>
        {items.map((m, i) => <MediaTile key={i} m={m} w={half} h={h} c={c} />)}
      </div>
    );
    if (n === 2) body = <>{col([media[0]], height)}{col([media[1]], height)}</>;
    else if (n === 3) body = <>{col([media[0]], height)}{col([media[1], media[2]], halfH)}</>;
    else body = <>{col([media[0], media[2]], halfH)}{col([media[1], media[3]], halfH)}</>;
  }
  return (
    <div style={{ display: "flex", gap, marginTop: 12, width, height, borderRadius: 16, overflow: "hidden", border: `1px solid ${c.lineStrong}` }}>
      {body}
    </div>
  );
}

function Post({
  post, input, c, width, last, number,
}: { post: PreviewPost; input: PreviewInput; c: Palette; width: number; last: boolean; number?: string }) {
  const contentWidth = width - 16 - 40 - 12 - 16;
  const text = post.text.trim().normalize();
  const longPosts = maxLengthFor(input.author.verifiedType) > STANDARD_MAX;
  let shown = text;
  let collapsed = false;
  if (longPosts) {
    const overflow = overflowIndex(text);
    if (overflow !== null) {
      const entity = tokenize(text).find((t) => t.type !== "text" && t.start < overflow && t.end > overflow);
      shown = text.slice(0, entity?.start ?? overflow).trimEnd();
      collapsed = true;
    }
  }
  return (
    <div style={{ display: "flex", padding: "12px 16px 0 16px", width }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 40, marginRight: 12 }}>
        <Avatar author={input.author} c={c} />
        {!last && <div style={{ display: "flex", flexGrow: 1, width: 2, marginTop: 4, borderRadius: 9999, background: c.lineStrong }} />}
      </div>
      <div style={{ display: "flex", flexDirection: "column", width: contentWidth, paddingBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", fontSize: 15, lineHeight: "20px", width: contentWidth, overflow: "hidden" }}>
          <span style={{ fontWeight: 700, color: c.ink }}>{input.author.name}</span>
          <Badge type={input.author.verifiedType} />
          <span style={{ color: c.muted, marginLeft: 4 }}>@{input.author.username}</span>
          <span style={{ color: c.muted, margin: "0 4px" }}>·</span>
          <span style={{ color: c.muted }}>now</span>
          {number && <span style={{ color: c.muted, marginLeft: "auto", fontSize: 12 }}>{number}</span>}
        </div>
        {(text || !post.media?.length) && (
          <div style={{ display: "block", marginTop: 2, width: contentWidth, fontSize: 15, lineHeight: "20px", color: c.ink, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {text ? <RichText text={shown} c={c} /> : <span style={{ color: c.muted, fontStyle: "italic" }}>Empty post</span>}
          </div>
        )}
        {collapsed && <div style={{ display: "flex", fontSize: 15, lineHeight: "20px", color: c.accent }}>Show more</div>}
        {post.media?.length ? <MediaGrid media={post.media} width={contentWidth} c={c} /> : null}
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, width: Math.min(contentWidth, 425) }}>
          {ICONS.map((d, i) => (
            <svg key={i} viewBox="0 0 24 24" width={17} height={17}>
              <path d={d} fill={c.muted} />
            </svg>
          ))}
        </div>
      </div>
    </div>
  );
}

export function PreviewTree({ input }: { input: PreviewInput }) {
  const c = THEMES[input.theme];
  const width = DEVICE_WIDTH[input.device];
  const total = input.total ?? input.posts.length;
  const offset = input.offset ?? 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", width, background: c.canvas, fontFamily: "Inter", paddingBottom: 4 }}>
      {input.posts.map((post, i) => (
        <Post
          key={i}
          post={post}
          input={input}
          c={c}
          width={width}
          last={i === input.posts.length - 1 && !input.remaining}
          number={input.numbered && total > 1 ? `${offset + i + 1}/${total}` : undefined}
        />
      ))}
      {input.remaining ? (
        <div style={{ display: "flex", padding: "12px 16px", color: c.accent, fontSize: 15, borderTop: `1px solid ${c.line}` }}>
          {`+${input.remaining} more post${input.remaining === 1 ? "" : "s"} in this thread`}
        </div>
      ) : null}
    </div>
  );
}

/** Render to PNG bytes (2x pixel density). Height follows the content. */
export async function renderPreviewPng(input: PreviewInput): Promise<{ png: Buffer; width: number; height: number }> {
  const width = DEVICE_WIDTH[input.device];
  const svg = await satori(<PreviewTree input={input} />, { width, fonts: await loadFonts(), loadAdditionalAsset });
  const img = new Resvg(svg, { fitTo: { mode: "zoom", value: SCALE }, font: { loadSystemFonts: false } }).render();
  return { png: Buffer.from(img.asPng()), width: img.width, height: img.height };
}
