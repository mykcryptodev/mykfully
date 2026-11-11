import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/errors";
import { assertSameOrigin } from "@/lib/http";
import { clearSession, getSession, revokeSessions } from "@/lib/session";

export const dynamic = "force-dynamic";

/** POST only (no GET: a cross-site <img src> must not be able to log users out). Revokes all sessions. */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const session = await getSession();
    if (session) await revokeSessions(session.userId);
    await clearSession();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
