import { getDb } from "@/lib/db";
import { requireUserId } from "@/lib/session";
import { deleteDraft, errorResponse, getDraft, HttpError, serializeDraft, updateDraft } from "@/lib/drafts";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const row = await getDraft(await getDb(), userId, id);
    if (!row) throw new HttpError(404, "Draft not found");
    return Response.json({ draft: serializeDraft(row) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const body = await req.json();
    const row = await updateDraft(await getDb(), userId, id, body);
    return Response.json({ draft: serializeDraft(row) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    await deleteDraft(await getDb(), userId, id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
