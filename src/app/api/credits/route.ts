import { getDb } from "@/lib/db";
import { CREDIT_COSTS, getBalance, isAdmin, listLedger } from "@/lib/credits";
import { errorResponse } from "@/lib/errors";
import { requireUserId } from "@/lib/session";
import { publicPurchaseInfo } from "@/lib/payments/config";
import { serializeLedger } from "@/app/api/admin/_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const userId = await requireUserId();
    const db = await getDb();
    const [balance, ledger] = await Promise.all([getBalance(db, userId), listLedger(db, userId, 50)]);
    return Response.json({
      balance,
      isAdmin: isAdmin(userId),
      costs: {
        post: CREDIT_COSTS.post,
        postWithUrl: CREDIT_COSTS.postWithUrl,
        userRead: CREDIT_COSTS.userRead,
        mediaUpload: CREDIT_COSTS.mediaUpload,
        mediaMetadata: CREDIT_COSTS.mediaMetadata,
      },
      ledger: ledger.map((r) => serializeLedger(r)),
      // Optional x402 credit purchases; `enabled: false` (and no packs) unless configured.
      purchase: publicPurchaseInfo(),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
