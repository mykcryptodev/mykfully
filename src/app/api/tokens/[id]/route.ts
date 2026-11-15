import { revokeApiToken, serializeToken, updateApiTokenScopes } from "@/lib/api-tokens";
import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { assertJson, assertSameOrigin } from "@/lib/http";
import { limitNamed } from "@/lib/ratelimit";
import { requireUserId } from "@/lib/session";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Change a token's permissions: `{ scopes: { schedule?, publish?, delete? } }`. Applies to the token's next request. */
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    assertSameOrigin(req);
    assertJson(req);
    const userId = await requireUserId();
    const db = await getDb();
    await limitNamed(db, "tokens", userId);
    const { id } = await params;
    const row = await updateApiTokenScopes(db, userId, id, await req.json());
    return Response.json({ apiToken: serializeToken(row) });
  } catch (e) {
    return errorResponse(e);
  }
}

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
