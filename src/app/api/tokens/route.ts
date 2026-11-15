import { createApiToken, listApiTokens, serializeToken } from "@/lib/api-tokens";
import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { assertJson, assertSameOrigin } from "@/lib/http";
import { limitNamed } from "@/lib/ratelimit";
import { requireUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

/** The signed-in user's live API tokens (session only; a token can't manage tokens). */
export async function GET() {
  try {
    const userId = await requireUserId();
    const rows = await listApiTokens(await getDb(), userId);
    return Response.json({ tokens: rows.map(serializeToken) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Create a token. The plaintext is in this response only. */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    assertJson(req);
    const userId = await requireUserId();
    const db = await getDb();
    await limitNamed(db, "tokens", userId);
    const { token, row } = await createApiToken(db, userId, await req.json());
    return Response.json({ token, apiToken: serializeToken(row) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
