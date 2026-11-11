import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb, schema } from "@/lib/db";
import { requireUserId } from "@/lib/session";
import type { DB } from "@/lib/db";
import { CreditCapReachedError, HttpError, InsufficientCreditsError, RateLimitedError, errorResponse } from "@/lib/errors";
import { assertSameSiteFetch } from "@/lib/http";
import { limitNamed } from "@/lib/ratelimit";
import { XApiError, XSearchUnavailableError, type XUser } from "@/lib/x/types";
import { getMeteredXClient } from "@/lib/x/metered";

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

/** Below this query length we never call X (cache only). */
const MIN_REMOTE_Q = 2;
/** If the local cache already has this many prefix matches, skip X entirely. */
const CACHE_SUFFICIENT = 5;

type Remote = { users: XUser[]; source: Source } | { creditsExhausted: true } | null;

const isCreditError = (e: unknown) => e instanceof InsufficientCreditsError || e instanceof CreditCapReachedError;

/**
 * Query X (metered). Returns null on soft failures (no client, X down) so the caller serves cache only.
 * Credit errors → { creditsExhausted }. RateLimitedError is rethrown (→ 429).
 * The lookup fallback only runs when search is unavailable on the tier or X returned a non-429 4xx.
 */
async function fetchFromX(db: DB, ownerId: string, q: string): Promise<Remote> {
  const key = `${ownerId}\u0000${q.toLowerCase()}`;
  const hit = memoGet(key);
  if (hit) return hit; // memo hits are free: checked before any debit

  let client;
  try {
    client = await getMeteredXClient(ownerId, "mentions.search");
  } catch (e) {
    console.warn("[mentions] no X client", e instanceof Error ? e.name : e);
    return null;
  }

  try {
    const users = await client.searchUsers(q, LIMIT);
    memoSet(key, users, "search");
    return { users, source: "search" };
  } catch (e) {
    if (isCreditError(e)) return { creditsExhausted: true };
    if (e instanceof RateLimitedError) throw e;
    const fallback =
      e instanceof XSearchUnavailableError || (e instanceof XApiError && e.status >= 400 && e.status < 500 && e.status !== 429);
    if (!fallback) {
      console.warn("[mentions] search failed", e instanceof XApiError ? e.status : e);
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
    if (isCreditError(e)) return { creditsExhausted: true };
    console.warn("[mentions] lookup failed", e instanceof XApiError ? e.status : e);
    return null;
  }
}

export async function GET(req: NextRequest) {
  let ownerId: string;
  const db = await getDb();
  try {
    assertSameSiteFetch(req); // this GET spends credits: block cross-site navigations
    ownerId = await requireUserId();
    await limitNamed(db, "search", ownerId); // 30/min per user, every request
  } catch (e) {
    return errorResponse(e);
  }

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().replace(/^@+/, "").slice(0, 50);
  if (q.length < 1) return errorResponse(new HttpError(400, "q is required"));

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

  let res: Remote = null;
  if (q.length >= MIN_REMOTE_Q && cached.length < CACHE_SUFFICIENT) {
    try {
      res = await fetchFromX(db, ownerId, q);
    } catch (e) {
      if (e instanceof RateLimitedError) return errorResponse(e); // defensive; X-side limits surface as XApiError
      console.warn("[mentions] remote failed", e);
    }
  }
  const creditsExhausted = !!res && "creditsExhausted" in res;
  const remote = res && "users" in res ? res : null;

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

  return NextResponse.json({
    users,
    source: remote?.source ?? "cache",
    ...(creditsExhausted ? { creditsExhausted: true } : {}),
  });
}
