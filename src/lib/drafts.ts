import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "./db";
import { drafts, users, type DraftStatus, type ThreadPost } from "./db/schema";
import { estimateThreadCost, getBalance, isAdmin } from "./credits";
import { HttpError } from "./errors";
import { countPost } from "./text";

export { HttpError, errorResponse } from "./errors";

export type DraftRow = typeof drafts.$inferSelect;

export type Draft = Omit<DraftRow, "scheduledAt" | "publishedAt" | "lockedAt" | "createdAt" | "updatedAt"> & {
  scheduledAt: string | null;
  publishedAt: string | null;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const SCHEDULE_SKEW_MS = 30_000;
/** Statuses a user may edit / delete / publish from. */
export const EDITABLE_STATUSES: DraftStatus[] = ["draft", "scheduled", "failed"];
export const MAX_DRAFTS_PER_USER = 500;
export const LIST_LIMIT = 200;
export const DRAFT_STATUSES = ["draft", "scheduled", "publishing", "published", "failed"] as const;

// Clients may only send id + text; any tweetId they send is stripped (zod strips unknown keys).
const postInput = z.object({
  id: z.string().min(1).max(100),
  text: z.string().max(25000),
});
const postsInput = z.array(postInput).min(1).max(50);

export const createDraftSchema = z.object({ posts: postsInput });
export const updateDraftSchema = z.object({
  posts: postsInput.optional(),
  scheduledAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
export const statusSchema = z.enum(DRAFT_STATUSES);

export type CreateDraftInput = z.input<typeof createDraftSchema>;
export type UpdateDraftInput = z.input<typeof updateDraftSchema>;

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

export function serializeDraft(row: DraftRow): Draft {
  return {
    ...row,
    scheduledAt: iso(row.scheduledAt),
    publishedAt: iso(row.publishedAt),
    lockedAt: iso(row.lockedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Throws 400 if the thread has no publishable content or contains an empty post. */
export function assertPublishable(posts: ThreadPost[]): void {
  if (posts.some((p) => p.text.trim() === "" && !p.tweetId)) {
    throw new HttpError(400, "Thread contains an empty post");
  }
}

/** Throws 400 if any not-yet-posted post exceeds the user's weighted length limit (280, or 25k for premium). */
export function assertPostLengths(posts: ThreadPost[], verifiedType: string | null | undefined): void {
  posts.forEach((p, i) => {
    if (p.tweetId) return;
    const text = p.text.trim();
    if (!text) return;
    const c = countPost(text, { verifiedType });
    if (!c.valid) {
      throw new HttpError(400, `Post ${i + 1} is too long (${c.weighted}/${c.max})`, {
        code: "post_too_long",
        index: i,
        weighted: c.weighted,
        max: c.max,
      });
    }
  });
}

/** Throws 402 insufficient_credits if a non-admin can't afford the unposted part of the thread. */
export async function assertCanAfford(db: DB, userId: string, posts: ThreadPost[]): Promise<void> {
  if (isAdmin(userId)) return;
  const needed = estimateThreadCost(posts);
  const balance = await getBalance(db, userId);
  if (balance < needed) {
    throw new HttpError(402, "Not enough credits", { code: "insufficient_credits", needed, balance });
  }
}

async function verifiedTypeOf(db: DB, userId: string): Promise<string | null> {
  const [u] = await db.select({ verifiedType: users.verifiedType }).from(users).where(eq(users.id, userId)).limit(1);
  return u?.verifiedType ?? null;
}

/**
 * Server-side checks run on schedule and publish-now (before claiming the draft):
 * no empty posts, every post within the user's length limit, and enough credits.
 */
export async function assertReadyToPublish(db: DB, userId: string, posts: ThreadPost[]): Promise<void> {
  assertPublishable(posts);
  assertPostLengths(posts, await verifiedTypeOf(db, userId));
  await assertCanAfford(db, userId, posts);
}

/** Merge client posts with stored ones, keeping server-side tweetIds (matched by post id). */
function mergePosts(incoming: { id: string; text: string }[], existing: ThreadPost[]): ThreadPost[] {
  const ids = new Set<string>();
  for (const p of incoming) {
    if (ids.has(p.id)) throw new HttpError(400, `Duplicate post id ${p.id}`);
    ids.add(p.id);
  }
  const byId = new Map(existing.map((p) => [p.id, p]));
  return incoming.map((p) => {
    const tweetId = byId.get(p.id)?.tweetId ?? null;
    return tweetId ? { id: p.id, text: p.text, tweetId } : { id: p.id, text: p.text };
  });
}

export async function listDrafts(db: DB, userId: string, status?: DraftStatus): Promise<DraftRow[]> {
  const where = status ? and(eq(drafts.userId, userId), eq(drafts.status, status)) : eq(drafts.userId, userId);
  return db.select().from(drafts).where(where).orderBy(desc(drafts.updatedAt)).limit(LIST_LIMIT);
}

export async function getDraft(db: DB, userId: string, id: string): Promise<DraftRow | null> {
  const [row] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, id), eq(drafts.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function createDraft(db: DB, userId: string, input: unknown): Promise<DraftRow> {
  const { posts } = createDraftSchema.parse(input);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(drafts)
    .where(eq(drafts.userId, userId));
  if (Number(n) >= MAX_DRAFTS_PER_USER) {
    throw new HttpError(403, `Draft limit reached (${MAX_DRAFTS_PER_USER}). Delete some drafts first.`, { code: "draft_limit" });
  }
  const [row] = await db
    .insert(drafts)
    .values({ id: randomUUID(), userId, posts: mergePosts(posts, []), status: "draft" })
    .returning();
  return row;
}

export async function updateDraft(db: DB, userId: string, id: string, input: unknown): Promise<DraftRow> {
  const patch = updateDraftSchema.parse(input);
  const current = await getDraft(db, userId, id);
  if (!current) throw new HttpError(404, "Draft not found");
  if (!EDITABLE_STATUSES.includes(current.status)) {
    throw new HttpError(409, `Draft is ${current.status} and can't be edited`);
  }

  const set: Partial<typeof drafts.$inferInsert> = { updatedAt: new Date() };
  const posts = patch.posts ? mergePosts(patch.posts, current.posts) : current.posts;
  if (patch.posts) set.posts = posts;

  if (patch.scheduledAt !== undefined) {
    if (patch.scheduledAt === null) {
      set.scheduledAt = null;
      set.status = "draft";
    } else {
      const at = new Date(patch.scheduledAt);
      if (at.getTime() < Date.now() - SCHEDULE_SKEW_MS) {
        throw new HttpError(400, "scheduledAt must be in the future");
      }
      await assertReadyToPublish(db, userId, posts);
      set.scheduledAt = at;
      set.status = "scheduled";
      set.attempts = 0;
      set.lastError = null;
    }
  } else if (current.status === "scheduled" && patch.posts) {
    assertPublishable(posts);
    assertPostLengths(posts, await verifiedTypeOf(db, userId));
  }

  // Single atomic statement; the status guard protects against a concurrent claim by the publisher.
  const [row] = await db
    .update(drafts)
    .set(set)
    .where(and(eq(drafts.id, id), eq(drafts.userId, userId), inArray(drafts.status, EDITABLE_STATUSES)))
    .returning();
  if (!row) throw new HttpError(409, "Draft is being published and can't be edited");
  return row;
}

export async function deleteDraft(db: DB, userId: string, id: string): Promise<void> {
  const deleted = await db
    .delete(drafts)
    .where(and(eq(drafts.id, id), eq(drafts.userId, userId), sql`${drafts.status} <> 'publishing'`))
    .returning({ id: drafts.id });
  if (deleted.length) return;
  const exists = await getDraft(db, userId, id);
  if (!exists) throw new HttpError(404, "Draft not found");
  throw new HttpError(409, "Draft is being published and can't be deleted");
}
