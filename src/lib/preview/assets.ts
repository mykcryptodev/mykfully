/**
 * satori `loadAdditionalAsset`: glyphs Inter doesn't have.
 * - Emoji → Twemoji SVGs (CC-BY 4.0) from jsDelivr.
 * - Other scripts (CJK, Arabic, Hebrew, Thai, Devanagari, …) → the matching Noto Sans subset from Google Fonts,
 *   requested with `text=` so only the needed glyphs are downloaded. Only the sorted set of unique characters is
 *   sent (never the draft's text in order), so Google can't read an unpublished draft from the request.
 * Every fetch has a short timeout and failures degrade to a missing glyph rather than a failed render.
 * Results are cached per process (bounded).
 */

const TIMEOUT_MS = 4000;
const MAX_CACHE = 500;
const TWEMOJI = "https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg/";

type FontAsset = { name: string; data: ArrayBuffer; weight: 400; style: "normal" };
let fontSeq = 0;
const cache = new Map<string, Promise<string | FontAsset[]>>();

const NOTO: Record<string, string> = {
  "ja-JP": "Noto Sans JP",
  "ko-KR": "Noto Sans KR",
  "zh-CN": "Noto Sans SC",
  "zh-TW": "Noto Sans TC",
  "zh-HK": "Noto Sans HK",
  "th-TH": "Noto Sans Thai",
  "bn-IN": "Noto Sans Bengali",
  "ar-AR": "Noto Sans Arabic",
  "ta-IN": "Noto Sans Tamil",
  "ml-IN": "Noto Sans Malayalam",
  "he-IL": "Noto Sans Hebrew",
  "te-IN": "Noto Sans Telugu",
  devanagari: "Noto Sans Devanagari",
  kannada: "Noto Sans Kannada",
  symbol: "Noto Sans Symbols 2",
  math: "Noto Sans Math",
  unknown: "Noto Sans",
};

async function fetchWithTimeout(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
}

/** Twemoji file name: code points in hex joined by "-"; FE0F is dropped unless the sequence has a ZWJ. */
export function twemojiCode(emoji: string): string {
  const cps = Array.from(emoji.includes("‍") ? emoji : emoji.replace(/️/g, ""), (ch) => ch.codePointAt(0)!.toString(16));
  return cps.join("-");
}

async function loadEmoji(segment: string): Promise<string> {
  const res = await fetchWithTimeout(`${TWEMOJI}${twemojiCode(segment)}.svg`);
  if (!res.ok) return "";
  const svg = await res.text();
  if (!svg.startsWith("<svg") || svg.length > 100_000) return "";
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/** Sorted unique characters of a segment (what we send to Google Fonts instead of the text itself). */
export function glyphSet(segment: string): string {
  return [...new Set(Array.from(segment))].filter((ch) => ch.trim()).sort().join("");
}

async function loadFont(languageCode: string, segment: string): Promise<FontAsset[]> {
  // Ambiguous scripts arrive as "ja-JP|zh-CN|zh-TW|zh-HK" (Han): use the first candidate.
  const family = NOTO[languageCode.split("|")[0]] ?? NOTO.unknown;
  const css = await (
    await fetchWithTimeout(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}&text=${encodeURIComponent(glyphSet(segment))}`)
  ).text();
  const url = /src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)\s*format\('(?:opentype|truetype)'\)/.exec(css)?.[1];
  if (!url) return [];
  const res = await fetchWithTimeout(url);
  if (!res.ok) return [];
  // Each response is a glyph subset for `segment`; satori keeps one font per name, so names must be unique.
  return [{ name: `${family} ${++fontSeq}`, data: await res.arrayBuffer(), weight: 400, style: "normal" }];
}

export async function loadAdditionalAsset(languageCode: string, segment: string): Promise<string | FontAsset[]> {
  const key = `${languageCode}:${languageCode === "emoji" ? segment : glyphSet(segment)}`;
  let p = cache.get(key);
  if (!p) {
    p = (languageCode === "emoji" ? loadEmoji(segment) : loadFont(languageCode, segment)).catch(() =>
      languageCode === "emoji" ? "" : [],
    );
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
    cache.set(key, p);
  }
  return p;
}
