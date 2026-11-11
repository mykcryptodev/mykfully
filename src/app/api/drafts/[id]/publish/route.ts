import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { drafts } from "@/lib/db/schema";
import { requireUserId } from "@/lib/session";
import { errorResponse, HttpError } from "@/lib/errors";
import { assertSameOrigin } from "@/lib/http";
import { limitNamed } from "@/lib/ratelimit";
import { getMeteredXClient } from "@/lib/x/metered";
import { assertReadyToPublish, EDITABLE_STATUSES, getDraft, serializeDraft } from "@/lib/drafts";
import { markFailed, markPublished, publishDraft } from "@/lib/publisher";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req); // no body: the client sends a bare POST
    const userId = await requireUserId();
    const { id } = await params;
    const db = await getDb();
    await limitNamed(db, "publish", userId);

    const current = await getDraft(db, userId, id);
    if (!current) throw new HttpError(404, "Draft not found");
    // Validate (lengths, credits) BEFORE claiming so a 402/400 never strands the draft in 'publishing'.
    await assertReadyToPublish(db, userId, current.posts);

    // Atomic claim: only one caller (user or cron) can move it into 'publishing'.
    const [claimed] = await db
      .update(drafts)
      .set({ status: "publishing", lockedAt: sql`now()`, updatedAt: new Date() })
      .where(and(eq(drafts.id, id), eq(drafts.userId, userId), inArray(drafts.status, EDITABLE_STATUSES)))
      .returning();
    if (!claimed) throw new HttpError(409, `Draft is ${current.status} and can't be published`);

    try {
      const client = await getMeteredXClient(userId, id);
      const posts = await publishDraft(db, claimed, client);
      const row = await markPublished(db, claimed, posts);
      return Response.json({ draft: serializeDraft(row) });
    } catch (e) {
      const row = await markFailed(db, id, e, { final: true });
      // Same body/status/headers as errorResponse, plus the (now failed) draft.
      const res = errorResponse(e);
      const body = (await res.json()) as Record<string, unknown>;
      return Response.json({ ...body, draft: serializeDraft(row) }, { status: res.status, headers: res.headers });
    }
  } catch (e) {
    return errorResponse(e);
  }
}
