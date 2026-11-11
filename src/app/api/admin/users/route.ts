import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { listUsersWithSpend, requireAdmin } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = await getDb();
    await requireAdmin(db);
    return Response.json({ users: await listUsersWithSpend(db) });
  } catch (e) {
    return errorResponse(e);
  }
}
