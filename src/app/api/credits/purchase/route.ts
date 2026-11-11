import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { errorResponse, HttpError } from "@/lib/errors";
import { assertJson, assertSameOrigin } from "@/lib/http";
import { getPurchaseConfig, isPackId } from "@/lib/payments/config";
import { purchaseCredits } from "@/lib/payments/purchases";
import { PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER, PAYMENT_SIGNATURE_HEADER } from "@/lib/payments/x402";
import { limitNamed } from "@/lib/ratelimit";
import { requireUserId } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({ packId: z.string().max(16) });

/**
 * Buy a credit pack with USDC over x402 (optional feature; 404 unless configured).
 * - No PAYMENT-SIGNATURE header → 402 with the x402 challenge (PAYMENT-REQUIRED header, base64 JSON).
 * - With the header → verify + settle through the facilitator, then credit → 200 { balance, credits, txHash }.
 * - Settlement not confirmed → 202 { pending: true }; nothing is credited until it is reconciled.
 *
 * The 402 here is the x402 challenge, NOT `insufficient_credits`: it is the one response that doesn't come from
 * errorResponse (its body still has `error` + `code`), and the client calls this route with a bare fetch.
 * Only `packId` is read from the body; amount, recipient, token and network are decided server-side.
 */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    assertJson(req);
    const userId = await requireUserId();
    const db = await getDb();
    await limitNamed(db, "purchase", userId);
    const cfg = getPurchaseConfig();
    if (!cfg) throw new HttpError(404, "Not found");
    const { packId } = Body.parse(await req.json());
    if (!isPackId(packId)) throw new HttpError(400, "Unknown credit pack", { code: "unknown_pack" });

    const header = req.headers.get(PAYMENT_SIGNATURE_HEADER);
    const out = await purchaseCredits(db, cfg, userId, packId, header, `${env.appUrl}/api/credits/purchase`);

    if (out.kind === "payment_required") {
      return Response.json(
        {
          error: out.error ? `Payment was not accepted (${out.error}). You were not charged.` : "Payment required",
          code: out.error ? "payment_rejected" : "payment_required",
          ...(out.error ? { reason: out.error } : {}),
        },
        { status: 402, headers: { [PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(out.challenge), "Cache-Control": "no-store" } },
      );
    }
    if (out.kind === "pending") {
      return Response.json({ pending: true, purchaseId: out.purchaseId }, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    return Response.json(
      { balance: out.balance, credits: out.credits, txHash: out.txHash },
      { headers: { [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(out.settlement), "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
