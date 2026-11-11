import { getDb } from "@/lib/db";
import { listLedger } from "@/lib/credits";
import { errorResponse } from "@/lib/errors";
import { requireAdmin, serializeLedger } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const db = await getDb();
    await requireAdmin(db);
    const { id } = await params;
    const ledger = await listLedger(db, id, 200);
    return Response.json({ ledger: ledger.map((r) => serializeLedger(r, { includeActor: true })) });
  } catch (e) {
    return errorResponse(e);
  }
}
