import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { clearSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST() {
  await clearSession();
  return NextResponse.json({ ok: true });
}

/** Convenience: <a href="/api/auth/logout"> logs out and lands on /login. */
export async function GET() {
  await clearSession();
  return NextResponse.redirect(new URL("/login", env.appUrl));
}
