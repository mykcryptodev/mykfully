import { getDb } from "@/lib/db";
import { requireUserId } from "@/lib/session";
import { errorResponse } from "@/lib/errors";
import { assertJson, assertSameOrigin } from "@/lib/http";
import { limitNamed } from "@/lib/ratelimit";
import { createDraft, listDrafts, serializeDraft, statusSchema } from "@/lib/drafts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const userId = await requireUserId();
    const raw = new URL(req.url).searchParams.get("status");
    const status = raw ? statusSchema.parse(raw) : undefined;
    const rows = await listDrafts(await getDb(), userId, status);
    return Response.json({ drafts: rows.map(serializeDraft) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    assertJson(req);
    const userId = await requireUserId();
    const db = await getDb();
    await limitNamed(db, "draftCreate", userId);
    const body = await req.json();
    const row = await createDraft(db, userId, body);
    return Response.json({ draft: serializeDraft(row) }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
