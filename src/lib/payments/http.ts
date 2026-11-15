import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { z } from "zod";
import type { DB } from "../db";
import { HttpError } from "../errors";
import { limitNamed } from "../ratelimit";
import { getPurchaseConfig, isPackId } from "./config";
import { purchaseCredits } from "./purchases";
import { PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER, PAYMENT_SIGNATURE_HEADER } from "./x402";

const Body = z.object({ packId: z.string().max(16) });

/**
 * The shared x402 purchase exchange behind POST /api/credits/purchase (browser session) and
 * POST /api/agent/credits/purchase (agent bearer token). The caller authenticates and picks `resourceUrl`
 * (the route's own URL, which goes into the challenge).
 * - No PAYMENT-SIGNATURE header → 402 with the x402 challenge (PAYMENT-REQUIRED header, base64 JSON).
 * - With the header → verify + settle through the facilitator, then credit → 200 { balance, credits, txHash }.
 * - Settlement not confirmed → 202 { pending: true }; nothing is credited until it is reconciled.
 * The 402 is the x402 challenge, not `insufficient_credits`; it is the one response that skips errorResponse.
 * Only `packId` is read from the body; amount, recipient, token and network are decided server-side.
 */
export async function handlePurchase(db: DB, userId: string, req: Request, resourceUrl: string): Promise<Response> {
  await limitNamed(db, "purchase", userId);
  const cfg = getPurchaseConfig();
  if (!cfg) throw new HttpError(404, "Not found");
  const { packId } = Body.parse(await req.json());
  if (!isPackId(packId)) throw new HttpError(400, "Unknown credit pack", { code: "unknown_pack" });

  const header = req.headers.get(PAYMENT_SIGNATURE_HEADER);
  const out = await purchaseCredits(db, cfg, userId, packId, header, resourceUrl);

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
}
