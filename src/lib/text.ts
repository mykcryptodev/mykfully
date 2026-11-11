/**
 * Post text helpers built on twitter-text. Pure functions: safe to import from
 * both server code and client components (no DOM / React).
 */
import * as twitterText from "twitter-text";

// twitter-text is CJS (`module.exports = default`); handle both interop shapes.
const tt = ((twitterText as unknown as { default?: typeof twitterText }).default ?? twitterText) as typeof twitterText;
const ttConfigs = (tt as unknown as { configs?: { defaults?: Record<string, unknown> } }).configs;

export const STANDARD_MAX = 280;
export const LONG_POST_MAX = 25000;

/** Verified types that may post long-form (up to 25k weighted chars). */
const LONG_POST_TYPES = new Set(["premium", "blue"]);

export function maxLengthFor(verifiedType?: string | null): number {
  return verifiedType && LONG_POST_TYPES.has(verifiedType) ? LONG_POST_MAX : STANDARD_MAX;
}

type MaxOpt = number | { verifiedType?: string | null } | undefined;

function resolveMax(opt: MaxOpt): number {
  if (typeof opt === "number") return opt;
  if (opt && typeof opt === "object") return maxLengthFor(opt.verifiedType);
  return STANDARD_MAX;
}

function parse(text: string, max: number) {
  // parseTweet replaces the config wholesale when options are passed, so spread the defaults.
  const base = ttConfigs?.defaults ?? {
    version: 3,
    scale: 100,
    defaultWeight: 200,
    emojiParsingEnabled: true,
    transformedURLLength: 23,
    ranges: [
      { start: 0, end: 4351, weight: 100 },
      { start: 8192, end: 8205, weight: 100 },
      { start: 8208, end: 8223, weight: 100 },
      { start: 8242, end: 8247, weight: 100 },
    ],
  };
  return tt.parseTweet(text, { ...base, maxWeightedTweetLength: max });
}

/**
 * Weighted X character count. `max` is 280 by default; pass a number or
 * `{ verifiedType }` (premium/blue → 25000).
 */
export function countPost(text: string, maxOpt?: MaxOpt): { weighted: number; valid: boolean; max: number } {
  const max = resolveMax(maxOpt);
  const p = parse(text, max);
  return { weighted: p.weightedLength, valid: p.valid, max };
}

/**
 * UTF-16 index where the text exceeds `max`, or null if it fits.
 * Used to highlight the overflowing part like X does.
 */
export function overflowIndex(text: string, maxOpt?: MaxOpt): number | null {
  const max = resolveMax(maxOpt);
  const p = parse(text, max);
  if (p.weightedLength <= max) return null;
  return p.validRangeEnd + 1;
}

export function extractMentions(text: string): string[] {
  return tt.extractMentions(text);
}

export function hasUrl(text: string): boolean {
  return tt.extractUrlsWithIndices(text).length > 0;
}

export type TokenType = "text" | "mention" | "hashtag" | "cashtag" | "url";
export type Token = { type: TokenType; text: string; start: number; end: number; value?: string };

/** Split text into plain / entity segments (UTF-16 indices), covering the whole string. */
export function tokenize(text: string): Token[] {
  const entities = tt.extractEntitiesWithIndices(text);
  const out: Token[] = [];
  let pos = 0;
  for (const e of entities) {
    const [s, end] = e.indices;
    if (s < pos) continue;
    if (s > pos) out.push({ type: "text", text: text.slice(pos, s), start: pos, end: s });
    let type: TokenType = "text";
    let value: string | undefined;
    if ("screenName" in e && e.screenName) {
      type = "mention";
      value = e.screenName;
    } else if ("hashtag" in e && e.hashtag) {
      type = "hashtag";
      value = e.hashtag;
    } else if ("cashtag" in e && e.cashtag) {
      type = "cashtag";
      value = e.cashtag;
    } else if ("url" in e && e.url) {
      type = "url";
      value = e.url;
    }
    out.push({ type, text: text.slice(s, end), start: s, end, value });
    pos = end;
  }
  if (pos < text.length) out.push({ type: "text", text: text.slice(pos), start: pos, end: text.length });
  return out;
}

function fits(text: string, max: number): boolean {
  return parse(text, max).weightedLength <= max;
}

/** Split an over-long chunk at the last whitespace that fits; falls back to a hard cut. */
function hardSplit(chunk: string, max: number): string[] {
  const out: string[] = [];
  let rest = chunk.trim();
  while (rest && !fits(rest, max)) {
    // binary search the longest prefix that fits
    let lo = 1;
    let hi = rest.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(rest.slice(0, mid), max)) lo = mid;
      else hi = mid - 1;
    }
    let cut = lo;
    const ws = rest.slice(0, lo + 1).search(/\s\S*$/);
    if (ws > lo * 0.5) cut = ws;
    // never split a surrogate pair
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function splitSentences(paragraph: string): string[] {
  const parts = paragraph.match(/[^.!?…\n]+(?:[.!?…]+["')\]]*|\n|$)\s*/g);
  return parts ? parts.map((s) => s) : [paragraph];
}

/**
 * Split long text into thread posts, preferring paragraph, then sentence, then
 * word boundaries, keeping every post within `max` weighted chars.
 */
export function splitIntoThread(text: string, maxOpt?: MaxOpt): string[] {
  const max = resolveMax(maxOpt);
  const trimmed = text.trim();
  if (!trimmed) return [""];
  if (fits(trimmed, max)) return [trimmed];

  // Units: paragraphs; paragraphs that don't fit are broken into sentences, then words.
  const units: { text: string; sep: string }[] = [];
  for (const para of trimmed.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (fits(p, max)) {
      units.push({ text: p, sep: "\n\n" });
      continue;
    }
    let first = true;
    for (const sentence of splitSentences(p)) {
      const s = sentence.trim();
      if (!s) continue;
      const pieces = fits(s, max) ? [s] : hardSplit(s, max);
      for (const piece of pieces) {
        units.push({ text: piece, sep: first ? "\n\n" : " " });
        first = false;
      }
    }
  }

  const posts: string[] = [];
  let cur = "";
  for (const u of units) {
    if (!cur) {
      cur = u.text;
      continue;
    }
    const candidate = cur + u.sep + u.text;
    if (fits(candidate, max)) cur = candidate;
    else {
      posts.push(cur);
      cur = u.text;
    }
  }
  if (cur) posts.push(cur);
  return posts;
}
