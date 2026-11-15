import { requireAgentUserId } from "@/lib/api-tokens";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { errorResponse } from "@/lib/errors";
import { assertJson } from "@/lib/http";
import { handlePurchase } from "@/lib/payments/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Agent credit purchase over x402: the same exchange as POST /api/credits/purchase, authenticated with an
 * API token (`Authorization: Bearer myk_…`) instead of the session cookie. No Origin check is needed: cookies
 * are ignored here, so a cross-site page can't make the browser authenticate this request.
 * Any x402 client works: POST {"packId":"p1"} → 402 challenge → retry with PAYMENT-SIGNATURE.
 */
export async function POST(req: Request) {
  try {
    assertJson(req);
    const db = await getDb();
    const userId = await requireAgentUserId(db, req);
    return await handlePurchase(db, userId, req, `${env.appUrl}/api/agent/credits/purchase`);
  } catch (e) {
    return errorResponse(e);
  }
}
