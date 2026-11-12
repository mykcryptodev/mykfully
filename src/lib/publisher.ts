import { and, eq, inArray, sql } from "drizzle-orm";
import * as twitterText from "twitter-text";
import type { DB } from "./db";
import { drafts, mentionCache, type ThreadPost } from "./db/schema";
import type { XClient } from "./x/types";
import type { DraftRow } from "./drafts";
import { AmbiguousPublishError, HttpError, isFatalPublishError, toPublicError } from "./errors";
import { loadMedia } from "./media";
import { uploadAttachment } from "./x/upload";

export const MAX_ATTEMPTS = 3;
/** Upload budget per post. Keeps a publish attempt inside the 60s function limit. */
export const MEDIA_UPLOAD_TIMEOUT_MS = 40_000;
const PERSIST_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Save posts[i].tweetId, retrying briefly. If it can't be saved, a retry would re-post the tweet, so throw
 * AmbiguousPublishError (fatal: the draft is marked failed, never auto-retried).
 */
async function persistTweetId(db: DB, draftId: string, i: number, id: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db
        .update(drafts)
        .set({
          posts: sql`jsonb_set(${drafts.posts}, ARRAY[${String(i)}, 'tweetId']::text[], to_jsonb(${id}::text))`,
          updatedAt: new Date(),
        })
        .where(eq(drafts.id, draftId));
      return;
    } catch (e) {
      if (attempt >= PERSIST_ATTEMPTS) {
        console.error("[publisher] failed to persist tweetId", { draftId, i, tweetId: id }, e instanceof Error ? e.name : e);
        throw new AmbiguousPublishError();
      }
      await sleep(100 * attempt);
    }
  }
}

/** Builds the (metered) X client for a draft's owner; `ref` is the draft id, recorded on ledger rows. */
export type GetClient = (userId: string, ref?: string) => Promise<XClient>;

// twitter-text is CJS (`module.exports = default`); handle both interop shapes.
const tt = ((twitterText as unknown as { default?: typeof twitterText }).default ?? twitterText) as typeof twitterText;

export function extractThreadMentions(posts: ThreadPost[]): string[] {
  const set = new Set<string>();
  for (const p of posts) for (const m of tt.extractMentions(p.text)) set.add(m.toLowerCase());
  return [...set];
}

/**
 * Post the thread sequentially. Each post replies to the previous tweet. After every successful post,
 * its tweetId is persisted immediately (single jsonb_set UPDATE) so a crash mid-thread resumes without
 * reposting. Posts that already have a tweetId are skipped; empty posts are skipped.
 * Attachments are uploaded to X right before their post (media IDs are short-lived). Upload failures happen
 * before postTweet, so they are never ambiguous and the post can be retried safely.
 * Returns the posts array with tweetIds filled in.
 */
export async function publishDraft(
  db: DB,
  draft: DraftRow,
  client: XClient,
  opts: { uploadTimeoutMs?: number } = {},
): Promise<ThreadPost[]> {
  const posts = draft.posts.map((p) => ({ ...p }));
  let prev: string | null = null;
  let postedAny = false;
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    if (p.tweetId) {
      prev = p.tweetId;
      postedAny = true;
      continue;
    }
    const text = p.text.trim();
    if (!text && !p.media?.length) continue;
    let mediaIds: string[] | undefined;
    if (p.media?.length) {
      const signal = AbortSignal.timeout(opts.uploadTimeoutMs ?? MEDIA_UPLOAD_TIMEOUT_MS);
      mediaIds = [];
      for (const attachment of p.media) {
        const { bytes, attachment: stored } = await loadMedia(db, draft.userId, attachment.id);
        mediaIds.push(await uploadAttachment(client, bytes, stored.contentType, attachment.altText, signal));
      }
    }
    const { id } = await client.postTweet(text, prev, mediaIds);
    p.tweetId = id;
    prev = id;
    postedAny = true;
    await persistTweetId(db, draft.id, i, id);
  }
  if (!postedAny) throw new HttpError(400, "Thread has no non-empty posts");
  return posts;
}

/** Atomically claim due (or stale publishing) drafts. Safe under concurrent callers. */
export async function claimDueDrafts(db: DB, limit = 10): Promise<DraftRow[]> {
  return db
    .update(drafts)
    .set({ status: "publishing", lockedAt: sql`now()` })
    .where(
      sql`${drafts.id} IN (
        SELECT id FROM drafts
        WHERE (status = 'scheduled' AND scheduled_at <= now())
           OR (status = 'publishing' AND locked_at < now() - interval '10 minutes')
        ORDER BY scheduled_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )`,
    )
    .returning();
}

/** Mark a successfully published draft and bump mention_cache counters. */
export async function markPublished(db: DB, draft: DraftRow, posts: ThreadPost[]): Promise<DraftRow> {
  const [row] = await db
    .update(drafts)
    .set({ status: "published", publishedAt: sql`now()`, lockedAt: null, lastError: null, updatedAt: new Date() })
    .where(eq(drafts.id, draft.id))
    .returning();
  const mentions = extractThreadMentions(posts);
  if (mentions.length) {
    try {
      await db
        .update(mentionCache)
        .set({ useCount: sql`${mentionCache.useCount} + 1`, lastUsedAt: sql`now()` })
        .where(and(eq(mentionCache.ownerId, draft.userId), inArray(sql`lower(${mentionCache.username})`, mentions)));
    } catch (e) {
      console.error("mention_cache bump failed", e);
    }
  }
  return row;
}

/**
 * UI-safe `last_error` text: `[code] message`, e.g. `[insufficient_credits] Not enough credits (need 15, have 0)`.
 * Never stores raw error messages (they can embed SQL, tokens or X response bodies).
 */
export function publicErrorText(error: unknown): string {
  const pe = toPublicError(error);
  const code = typeof pe.extra?.code === "string" ? pe.extra.code : pe.code;
  return `[${code}] ${pe.message}`.slice(0, 500);
}

/**
 * Record a failed attempt: attempts++, last_error; back to scheduled (retry) or failed at MAX_ATTEMPTS.
 * Fatal errors (no credits, reconnect needed, X 401/403, cap reached) fail immediately with no retry.
 * Already-posted tweetIds are untouched, so re-scheduling/publishing later resumes the thread.
 */
export async function markFailed(db: DB, draftId: string, error: unknown, opts: { final?: boolean } = {}): Promise<DraftRow> {
  const final = opts.final || isFatalPublishError(error);
  const status = final
    ? sql`'failed'`
    : sql`CASE WHEN ${drafts.attempts} + 1 >= ${MAX_ATTEMPTS} OR ${drafts.scheduledAt} IS NULL THEN 'failed' ELSE 'scheduled' END`;
  const [row] = await db
    .update(drafts)
    .set({
      attempts: sql`${drafts.attempts} + 1`,
      lastError: publicErrorText(error),
      status,
      lockedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(drafts.id, draftId))
    .returning();
  return row;
}

export type PublishResult = { id: string; status: "published" | "scheduled" | "failed"; error?: string };

export async function runDuePublishing(db: DB, getClient: GetClient, limit = 10): Promise<PublishResult[]> {
  const claimed = await claimDueDrafts(db, limit);
  const results: PublishResult[] = [];
  for (const draft of claimed) {
    try {
      const client = await getClient(draft.userId, draft.id);
      const posts = await publishDraft(db, draft, client);
      await markPublished(db, draft, posts);
      results.push({ id: draft.id, status: "published" });
    } catch (e) {
      const row = await markFailed(db, draft.id, e).catch(() => null);
      results.push({
        id: draft.id,
        status: row?.status === "failed" ? "failed" : "scheduled",
        error: publicErrorText(e),
      });
    }
  }
  return results;
}
