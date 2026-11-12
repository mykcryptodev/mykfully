import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { assertJson, assertSameOrigin } from "@/lib/http";
import { appendMediaChunk, mediaResponse, readMediaJson } from "@/lib/media";
import { limitNamed } from "@/lib/ratelimit";
import { requireUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    assertSameOrigin(req);
    assertJson(req);
    const userId = await requireUserId();
    const db = await getDb();
    await limitNamed(db, "mediaChunk", userId);
    const { id } = await params;
    const uploadedSize = await appendMediaChunk(db, userId, id, await readMediaJson(req, true));
    return Response.json({ uploadedSize });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function GET(req: Request, { params }: Ctx) {
  try {
    const userId = await requireUserId();
    const db = await getDb();
    await limitNamed(db, "mediaRead", userId);
    const { id } = await params;
    return await mediaResponse(db, userId, id, req.headers.get("range"));
  } catch (e) {
    return errorResponse(e);
  }
}
