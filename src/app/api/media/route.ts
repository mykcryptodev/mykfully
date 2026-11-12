import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { assertJson, assertSameOrigin } from "@/lib/http";
import { readMediaJson, startMediaUpload } from "@/lib/media";
import { limitNamed } from "@/lib/ratelimit";
import { requireUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    assertJson(req);
    const userId = await requireUserId();
    const db = await getDb();
    await limitNamed(db, "mediaStart", userId);
    const attachment = await startMediaUpload(db, userId, await readMediaJson(req));
    return Response.json({ attachment }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
