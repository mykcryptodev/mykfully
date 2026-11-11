import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { drafts } from "@/lib/db/schema";
import { requireUserId } from "@/lib/session";
import { getXClientForUser } from "@/lib/x";
import { assertPublishable, EDITABLE_STATUSES, errorResponse, getDraft, HttpError, serializeDraft } from "@/lib/drafts";
import { markFailed, markPublished, publishDraft } from "@/lib/publisher";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const db = await getDb();

    const current = await getDraft(db, userId, id);
    if (!current) throw new HttpError(404, "Draft not found");
    assertPublishable(current.posts);

    // Atomic claim: only one caller (user or cron) can move it into 'publishing'.
    const [claimed] = await db
      .update(drafts)
      .set({ status: "publishing", lockedAt: sql`now()`, updatedAt: new Date() })
      .where(and(eq(drafts.id, id), eq(drafts.userId, userId), inArray(drafts.status, EDITABLE_STATUSES)))
      .returning();
    if (!claimed) throw new HttpError(409, `Draft is ${current.status} and can't be published`);

    try {
      const client = await getXClientForUser(userId);
      const posts = await publishDraft(db, claimed, client);
      const row = await markPublished(db, claimed, posts);
      return Response.json({ draft: serializeDraft(row) });
    } catch (e) {
      const row = await markFailed(db, id, e, { final: true });
      const message = e instanceof Error ? e.message : String(e);
      return Response.json({ error: message, draft: serializeDraft(row) }, { status: 502 });
    }
  } catch (e) {
    return errorResponse(e);
  }
}
