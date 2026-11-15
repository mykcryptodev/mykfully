import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { errorResponse } from "@/lib/errors";
import { assertJson, assertSameOrigin } from "@/lib/http";
import { handlePurchase } from "@/lib/payments/http";
import { requireUserId } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Buy a credit pack with USDC over x402 from the web app (optional feature; 404 unless configured).
 * See handlePurchase for the exchange. The client calls this route with a bare fetch (apiFetch treats 402 as
 * insufficient credits).
 */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    assertJson(req);
    const userId = await requireUserId();
    return await handlePurchase(await getDb(), userId, req, `${env.appUrl}/api/credits/purchase`);
  } catch (e) {
    return errorResponse(e);
  }
}
