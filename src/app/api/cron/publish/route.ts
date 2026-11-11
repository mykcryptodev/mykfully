import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { getXClientForUser } from "@/lib/x";
import { runDuePublishing } from "@/lib/publisher";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  let secret: string;
  try {
    secret = env.cronSecret;
  } catch {
    return false; // CRON_SECRET unset => endpoint disabled
  }
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function handle(req: Request) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const results = await runDuePublishing(await getDb(), getXClientForUser);
    return Response.json({ processed: results.length, results });
  } catch (e) {
    console.error("cron publish failed", e);
    return Response.json({ error: e instanceof Error ? e.message : "internal_error" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
