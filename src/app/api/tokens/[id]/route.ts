import { revokeApiToken } from "@/lib/api-tokens";
import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { assertSameOrigin } from "@/lib/http";
import { limitNamed } from "@/lib/ratelimit";
import { requireUserId } from "@/lib/session";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(req: Request, { params }: Ctx) {
  try {
    assertSameOrigin(req);
    const userId = await requireUserId();
    const db = await getDb();
    await limitNamed(db, "tokens", userId);
    const { id } = await params;
    await revokeApiToken(db, userId, id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
