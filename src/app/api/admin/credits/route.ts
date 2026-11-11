import { z } from "zod";
import { getDb } from "@/lib/db";
import { grant } from "@/lib/credits";
import { errorResponse, HttpError } from "@/lib/errors";
import { assertJson, assertSameOrigin } from "@/lib/http";
import { requireAdmin } from "../_lib";

export const dynamic = "force-dynamic";

const Body = z.object({
  userId: z.string().min(1).max(64),
  delta: z
    .number()
    .int()
    .refine((n) => n !== 0, "delta must be non-zero")
    .refine((n) => Math.abs(n) <= 10_000_000, "delta too large"),
  reason: z.string().trim().min(1).max(200),
});

/** Grant (delta > 0) or revoke (delta < 0) credits. Revokes clamp the balance at 0. */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    assertJson(req);
    const db = await getDb();
    const adminId = await requireAdmin(db);
    const { userId, delta, reason } = Body.parse(await req.json());
    const balance = await grant(db, adminId, userId, delta, reason);
    if (balance === null) throw new HttpError(404, "User not found");
    return Response.json({ balance });
  } catch (e) {
    return errorResponse(e);
  }
}
