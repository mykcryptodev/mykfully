import { getDb } from "@/lib/db";
import { requireUserId } from "@/lib/session";
import { errorResponse } from "@/lib/errors";
import { assertSameOrigin } from "@/lib/http";
import { limitNamed } from "@/lib/ratelimit";
import { serializeDraft } from "@/lib/drafts";
import { publishNow } from "@/lib/publish-now";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req); // no body: the client sends a bare POST
    const userId = await requireUserId();
    const { id } = await params;
    const db = await getDb();
    await limitNamed(db, "publish", userId);

    const out = await publishNow(db, userId, id);
    if (out.ok) return Response.json({ draft: serializeDraft(out.draft) });
    // Same body/status/headers as errorResponse, plus the (now failed) draft.
    const res = errorResponse(out.error);
    const body = (await res.json()) as Record<string, unknown>;
    return Response.json({ ...body, draft: serializeDraft(out.draft) }, { status: res.status, headers: res.headers });
  } catch (e) {
    return errorResponse(e);
  }
}
