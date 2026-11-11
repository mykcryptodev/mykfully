import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb, schema } from "@/lib/db";
import { UnauthorizedError, requireUserId, unauthorized } from "@/lib/session";
import { XApiError, XSearchUnavailableError, getXClientForUser, type XUser } from "@/lib/x";

export const dynamic = "force-dynamic";

const LIMIT = 8;
const TTL_MS = 60_000;
type Source = "search" | "lookup" | "cache";
type CacheEntry = { at: number; users: XUser[]; source: Source };

// Per-process memo of X results (search is billed per user returned), keyed by owner + query.
const g = globalThis as unknown as { __mykMentionMemo?: Map<string, CacheEntry> };
const memo = (g.__mykMentionMemo ??= new Map());

function memoGet(key: string): CacheEntry | null {
  const e = memo.get(key);
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) {
    memo.delete(key);
    return null;
  }
  return e;
}

function memoSet(key: string, users: XUser[], source: Source) {
  if (memo.size > 1000) {
    const now = Date.now();
    for (const [k, v] of memo) if (now - v.at > TTL_MS) memo.delete(k);
    if (memo.size > 1000) memo.clear();
  }
  memo.set(key, { at: Date.now(), users, source });
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

async function fetchFromX(ownerId: string, q: string): Promise<{ users: XUser[]; source: Source } | null> {
  const key = `${ownerId}\u0000${q.toLowerCase()}`;
  const hit = memoGet(key);
  if (hit) return hit;

  let client;
  try {
    client = await getXClientForUser(ownerId);
  } catch (e) {
    console.warn("[mentions] no X client", e);
    return null;
  }

  try {
    const users = await client.searchUsers(q, LIMIT);
    memoSet(key, users, "search");
    return { users, source: "search" };
  } catch (e) {
    const fallback = e instanceof XSearchUnavailableError || (e instanceof XApiError && e.status >= 400 && e.status < 500);
    if (!fallback) {
      console.warn("[mentions] search failed", e);
      return null;
    }
  }

  if (!/^[A-Za-z0-9_]{1,15}$/.test(q)) {
    memoSet(key, [], "lookup");
    return { users: [], source: "lookup" };
  }
  try {
    const users = await client.lookupUsernames([q]);
    memoSet(key, users, "lookup");
    return { users, source: "lookup" };
  } catch (e) {
    console.warn("[mentions] lookup failed", e);
    return null;
  }
}

export async function GET(req: NextRequest) {
  let ownerId: string;
  try {
    ownerId = await requireUserId();
  } catch (e) {
    if (e instanceof UnauthorizedError) return unauthorized();
    throw e;
  }

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().replace(/^@+/, "").slice(0, 50);
  if (q.length < 1) return NextResponse.json({ error: "q is required" }, { status: 400 });

  const db = await getDb();
  const mc = schema.mentionCache;
  const pattern = `${escapeLike(q)}%`;
  const cachedRows = await db
    .select()
    .from(mc)
    .where(and(eq(mc.ownerId, ownerId), or(ilike(mc.username, pattern), ilike(mc.name, pattern))))
    .orderBy(desc(mc.useCount), desc(mc.lastUsedAt))
    .limit(LIMIT);

  const cached: XUser[] = cachedRows.map((r) => ({
    id: r.xUserId,
    username: r.username,
    name: r.name,
    profileImageUrl: r.profileImageUrl,
    verifiedType: r.verifiedType,
  }));

  const remote = await fetchFromX(ownerId, q);

  if (remote && remote.users.length > 0) {
    const now = new Date();
    try {
      await db
        .insert(mc)
        .values(
          remote.users.map((u) => ({
            ownerId,
            xUserId: u.id,
            username: u.username,
            name: u.name,
            profileImageUrl: u.profileImageUrl ?? null,
            verifiedType: u.verifiedType ?? null,
            lastUsedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [mc.ownerId, mc.xUserId],
          // refresh profile data only; use_count / last_used_at are bumped on publish
          set: {
            username: sql`excluded.username`,
            name: sql`excluded.name`,
            profileImageUrl: sql`excluded.profile_image_url`,
            verifiedType: sql`excluded.verified_type`,
          },
        });
    } catch (e) {
      console.warn("[mentions] cache upsert failed", e);
    }
  }

  // Merge: cache first (user's own history), then X; dedupe by id. X data is fresher, so prefer it.
  const remoteById = new Map((remote?.users ?? []).map((u) => [u.id, u]));
  const seen = new Set<string>();
  const users: XUser[] = [];
  for (const u of [...cached, ...(remote?.users ?? [])]) {
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    users.push(remoteById.get(u.id) ?? u);
    if (users.length >= LIMIT) break;
  }

  return NextResponse.json({ users, source: remote?.source ?? "cache" });
}
