import { eq } from "drizzle-orm";
import sharp from "sharp";
import type { DB } from "../db";
import { users, type ThreadPost } from "../db/schema";
import { HttpError } from "../errors";
import { loadMedia } from "../media";
import type { MediaAttachment } from "../media-types";
import { renderPreviewPng, type PreviewDevice, type PreviewMedia, type PreviewTheme } from "./render";

export { DEVICE_WIDTH, type PreviewDevice, type PreviewTheme } from "./render";

/** Posts per image. Longer threads are paged with `start` so an image stays a reasonable size. */
export const PREVIEW_PAGE_SIZE = 8;
/**
 * Output budget per image. Vercel caps function responses at 4.5 MB and the MCP result carries the image as
 * base64 (+33%), so stay well under: PNG first, then JPEG, then fewer posts per page.
 */
export const PREVIEW_MAX_BYTES = 2_500_000;
/** Embedded media is scaled to at most the widest rendered size (desktop 600px at 2x). */
const MEDIA_MAX_PX = 1200;
const AVATAR_HOSTS = new Set(["pbs.twimg.com", "abs.twimg.com", "unavatar.io"]);
const AVATAR_MAX_BYTES = 1024 * 1024;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 4000;

/** Width/height from a PNG, JPEG or WebP header; null if unrecognised. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      const len = dv.getUint16(i + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (b.length > 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const kind = ascii(12, 4);
    if (kind === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (kind === "VP8 ") return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    if (kind === "VP8L") {
      const bits = dv.getUint32(21, true);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
  }
  return null;
}

/** Fetch the author's avatar from an allowlisted host into a data URI; null on any problem (falls back to an initial). */
async function fetchAvatar(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const u = new URL(url.replace("_normal.", "_200x200."));
    if (u.protocol !== "https:" || !AVATAR_HOSTS.has(u.hostname)) return null;
    const res = await fetch(u, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!res.ok || !/^image\/(png|jpeg|webp)$/.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > AVATAR_MAX_BYTES) return null;
    const png = await sharp(buf).resize(80, 80, { fit: "cover" }).png().toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Static images and a GIF's first frame are decoded with sharp (JPEG/PNG/WebP/GIF), scaled to display size and
 * embedded as JPEG. resvg can't decode WebP itself, and full-size photos would bloat the render.
 * Videos (and anything that fails) render as placeholders.
 */
async function previewMedia(db: DB, userId: string, m: MediaAttachment): Promise<PreviewMedia> {
  if (m.contentType === "video/mp4") return { kind: "video", altText: m.altText };
  const kind = m.contentType === "image/gif" ? "gif" : "image";
  if (m.size > IMAGE_MAX_BYTES * (kind === "gif" ? 3 : 1)) return { kind: "unavailable", altText: m.altText };
  try {
    const { bytes } = await loadMedia(db, userId, m.id);
    const { data, info } = await sharp(bytes, { pages: 1, limitInputPixels: 50_000_000 })
      .rotate()
      .resize({ width: MEDIA_MAX_PX, height: MEDIA_MAX_PX * 2, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    return { kind: "image", dataUri: `data:image/jpeg;base64,${data.toString("base64")}`, width: info.width, height: info.height, altText: m.altText, ...(kind === "gif" ? { badge: "GIF" } : {}) };
  } catch {
    return { kind: "unavailable", altText: m.altText };
  }
}

export type PreviewOptions = { device: PreviewDevice; theme: PreviewTheme; numbered: boolean; start: number };

/**
 * Render posts (a saved draft's, or unsaved text) for `userId` as the signed-in user's X profile would show them.
 * Media is loaded through `loadMedia`, which is scoped to the owner.
 */
export async function renderThreadPreview(
  db: DB,
  userId: string,
  posts: Pick<ThreadPost, "text" | "media">[],
  opts: PreviewOptions,
): Promise<{ image: Buffer; mimeType: "image/png" | "image/jpeg"; width: number; height: number; shown: [number, number]; total: number }> {
  if (!posts.length) throw new HttpError(400, "Nothing to preview");
  const total = posts.length;
  const start = Math.min(Math.max(0, opts.start), total - 1);
  const page = posts.slice(start, start + PREVIEW_PAGE_SIZE);
  const [u] = await db
    .select({ name: users.name, username: users.username, verifiedType: users.verifiedType, profileImageUrl: users.profileImageUrl })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) throw new HttpError(404, "User not found");
  const [avatar, pagePosts] = await Promise.all([
    fetchAvatar(u.profileImageUrl),
    Promise.all(
      page.map(async (p) => ({
        text: p.text,
        media: p.media?.length ? await Promise.all(p.media.map((m) => previewMedia(db, userId, m))) : undefined,
      })),
    ),
  ]);
  const author = { name: u.name, username: u.username, verifiedType: u.verifiedType, avatar };
  // Fit the byte budget: PNG (crisp text), else JPEG, else drop posts from the end of the page and page further.
  for (let count = pagePosts.length; ; count = Math.ceil(count / 2)) {
    const out = await renderPreviewPng({
      author,
      posts: pagePosts.slice(0, count),
      device: opts.device,
      theme: opts.theme,
      numbered: opts.numbered,
      offset: start,
      total,
      remaining: total - start - count,
    });
    let image = out.png;
    let mimeType: "image/png" | "image/jpeg" = "image/png";
    if (image.length > PREVIEW_MAX_BYTES) {
      image = await sharp(out.png).jpeg({ quality: 85 }).toBuffer();
      mimeType = "image/jpeg";
    }
    if (image.length <= PREVIEW_MAX_BYTES || count === 1) {
      if (image.length > PREVIEW_MAX_BYTES) image = await sharp(out.png).jpeg({ quality: 60 }).toBuffer();
      return { image, mimeType, width: out.width, height: out.height, shown: [start, start + count - 1], total };
    }
  }
}
