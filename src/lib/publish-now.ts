import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "./db";
import { drafts } from "./db/schema";
import { assertReadyToPublish, EDITABLE_STATUSES, getDraft, type DraftRow } from "./drafts";
import { HttpError } from "./errors";
import { markFailed, markPublished, publishDraft, type GetClient } from "./publisher";
import { getMeteredXClient } from "./x/metered";

export type PublishNowResult = { ok: true; draft: DraftRow } | { ok: false; draft: DraftRow; error: unknown };

/**
 * Publish a draft immediately (the app's "Publish now" and the agent `publish_draft` tool).
 * - Validation (lengths, credits) runs BEFORE the claim, so a 400/402 throws and never strands the draft.
 * - The claim is one status-guarded UPDATE: only one caller (user, agent or cron) can move it to 'publishing'.
 * - Posting goes through the metered client; any failure after the claim marks the draft failed (final, never
 *   auto-retried) and is returned, not thrown, together with the failed row.
 */
export async function publishNow(db: DB, userId: string, id: string, getClient: GetClient = getMeteredXClient): Promise<PublishNowResult> {
  const current = await getDraft(db, userId, id);
  if (!current) throw new HttpError(404, "Draft not found");
  await assertReadyToPublish(db, userId, current.posts);

  const [claimed] = await db
    .update(drafts)
    .set({ status: "publishing", lockedAt: sql`now()`, updatedAt: new Date() })
    .where(and(eq(drafts.id, id), eq(drafts.userId, userId), inArray(drafts.status, EDITABLE_STATUSES)))
    .returning();
  if (!claimed) throw new HttpError(409, `Draft is ${current.status} and can't be published`);

  try {
    const client = await getClient(userId, id);
    const posts = await publishDraft(db, claimed, client);
    return { ok: true, draft: await markPublished(db, claimed, posts) };
  } catch (error) {
    return { ok: false, draft: await markFailed(db, id, error, { final: true }), error };
  }
}
