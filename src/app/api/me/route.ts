import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { UnauthorizedError, requireUserId, unauthorized } from "@/lib/session";

export const dynamic = "force-dynamic";

function isValidTimeZone(tz: string): boolean {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone");
    if (supported?.includes(tz) || tz === "UTC") return true;
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function loadUser(userId: string) {
  const db = await getDb();
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    profileImageUrl: u.profileImageUrl,
    verifiedType: u.verifiedType,
    timezone: u.timezone,
  };
}

export async function GET() {
  try {
    const user = await loadUser(await requireUserId());
    if (!user) return unauthorized(); // session for a deleted user
    return NextResponse.json({ user });
  } catch (e) {
    if (e instanceof UnauthorizedError) return unauthorized();
    throw e;
  }
}

const Patch = z.object({ timezone: z.string().min(1).max(64).refine(isValidTimeZone, "Invalid IANA time zone") });

export async function PATCH(req: NextRequest) {
  try {
    const userId = await requireUserId();
    const parsed = Patch.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
    }
    const db = await getDb();
    await db
      .update(schema.users)
      .set({ timezone: parsed.data.timezone, updatedAt: new Date() })
      .where(eq(schema.users.id, userId));
    const user = await loadUser(userId);
    if (!user) return unauthorized();
    return NextResponse.json({ user });
  } catch (e) {
    if (e instanceof UnauthorizedError) return unauthorized();
    throw e;
  }
}
