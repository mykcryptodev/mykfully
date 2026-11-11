import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "./db";
import { drafts, type DraftStatus, type ThreadPost } from "./db/schema";
import { UnauthorizedError } from "./session";

export type DraftRow = typeof drafts.$inferSelect;

export type Draft = Omit<DraftRow, "scheduledAt" | "publishedAt" | "lockedAt" | "createdAt" | "updatedAt"> & {
  scheduledAt: string | null;
  publishedAt: string | null;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Error with an HTTP status, mapped by route handlers. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const SCHEDULE_SKEW_MS = 30_000;
/** Statuses a user may edit / delete / publish from. */
export const EDITABLE_STATUSES: DraftStatus[] = ["draft", "scheduled", "failed"];
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
  return db.select().from(drafts).where(where).orderBy(desc(drafts.updatedAt));
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
      assertPublishable(posts);
      set.scheduledAt = at;
      set.status = "scheduled";
      set.attempts = 0;
      set.lastError = null;
    }
  } else if (current.status === "scheduled" && patch.posts) {
    assertPublishable(posts);
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

/** Map thrown errors to JSON responses for route handlers. */
export function errorResponse(e: unknown): Response {
  if (e instanceof UnauthorizedError) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (e instanceof z.ZodError) {
    return Response.json({ error: "invalid_request", issues: e.issues }, { status: 400 });
  }
  if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
  if (e instanceof SyntaxError) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  console.error(e);
  return Response.json({ error: "internal_error" }, { status: 500 });
}
