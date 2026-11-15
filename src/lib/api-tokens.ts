import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "./db";
import { apiTokens, users } from "./db/schema";
import { HttpError } from "./errors";
import { clientIp } from "./http";
import { limitNamed } from "./ratelimit";
import { UnauthorizedError } from "./session";

/**
 * Personal API tokens let agents act for a user without a browser session.
 * - Format: `myk_` + 43 base64url chars (32 random bytes). High entropy, so a fast SHA-256 is enough.
 * - Only the hash is stored; the plaintext is shown once at creation.
 * - Tokens are only accepted by agent routes (`/api/mcp`, `/api/agent/**`), always as `Authorization: Bearer`.
 *   They never unlock session routes (admin, token management, logout).
 * - Drafting is always allowed. Scheduling, publishing and deleting are per-token permissions the user sets (and
 *   can change) in the app. They are read from the row on every request, so a change applies to the next call.
 */
export const TOKEN_PREFIX = "myk_";
export const MAX_TOKENS_PER_USER = 20;
const TOKEN_RE = /^myk_[A-Za-z0-9_-]{43}$/;

export type ApiTokenRow = typeof apiTokens.$inferSelect;
export type TokenScopes = { schedule: boolean; publish: boolean; delete: boolean };
export const NO_SCOPES: TokenScopes = { schedule: false, publish: false, delete: false };

export type PublicApiToken = {
  id: string;
  name: string;
  prefix: string;
  scopes: TokenScopes;
  createdAt: string;
  lastUsedAt: string | null;
};

const scopesInput = z.object({ schedule: z.boolean().optional(), publish: z.boolean().optional(), delete: z.boolean().optional() }).strict();
export const createTokenSchema = z.object({ name: z.string().trim().min(1).max(60), scopes: scopesInput.optional() });
export const updateTokenSchema = z.object({ scopes: scopesInput });

function scopesOf(row: Pick<ApiTokenRow, "canSchedule" | "canPublish" | "canDelete">): TokenScopes {
  return { schedule: row.canSchedule, publish: row.canPublish, delete: row.canDelete };
}

/** Column values for a partial scopes patch. */
function scopeColumns(s: z.output<typeof scopesInput> | undefined) {
  return {
    ...(s?.schedule !== undefined ? { canSchedule: s.schedule } : {}),
    ...(s?.publish !== undefined ? { canPublish: s.publish } : {}),
    ...(s?.delete !== undefined ? { canDelete: s.delete } : {}),
  };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function serializeToken(row: ApiTokenRow): PublicApiToken {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: scopesOf(row),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

/** Create a token. Returns the plaintext exactly once, alongside the stored row. */
export async function createApiToken(db: DB, userId: string, input: unknown): Promise<{ token: string; row: ApiTokenRow }> {
  const { name, scopes } = createTokenSchema.parse(input);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));
  if (Number(n) >= MAX_TOKENS_PER_USER) {
    throw new HttpError(403, `Token limit reached (${MAX_TOKENS_PER_USER}). Revoke one first.`, { code: "token_limit" });
  }
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const [row] = await db
    .insert(apiTokens)
    .values({ id: randomUUID(), userId, name, tokenHash: hashToken(token), prefix: token.slice(0, 10), ...scopeColumns(scopes) })
    .returning();
  return { token, row };
}

export async function listApiTokens(db: DB, userId: string): Promise<ApiTokenRow[]> {
  return db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .orderBy(desc(apiTokens.createdAt));
}

/** Revoke one of the user's tokens. 404 if it isn't theirs or is already revoked. */
export async function revokeApiToken(db: DB, userId: string, id: string): Promise<void> {
  const rows = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  if (!rows.length) throw new HttpError(404, "Token not found");
}

/** Change a live token's permissions (partial). 404 if it isn't the user's or is revoked. */
export async function updateApiTokenScopes(db: DB, userId: string, id: string, input: unknown): Promise<ApiTokenRow> {
  const { scopes } = updateTokenSchema.parse(input);
  const set = scopeColumns(scopes);
  const where = and(eq(apiTokens.id, id), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt));
  const [row] = Object.keys(set).length
    ? await db.update(apiTokens).set(set).where(where).returning()
    : await db.select().from(apiTokens).where(where).limit(1);
  if (!row) throw new HttpError(404, "Token not found");
  return row;
}

export type AgentAuth = { userId: string; tokenId: string; scopes: TokenScopes };

/** Resolve a plaintext token to its user and current permissions (and record last use), or null if unknown/revoked. */
export async function resolveApiToken(db: DB, token: string): Promise<AgentAuth | null> {
  if (!TOKEN_RE.test(token)) return null;
  // One statement: only live tokens whose user still exists match; last_used_at is updated in the same step.
  const rows = await db
    .update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(apiTokens.tokenHash, hashToken(token)),
        isNull(apiTokens.revokedAt),
        sql`exists (select 1 from ${users} where ${users.id} = ${apiTokens.userId})`,
      ),
    )
    .returning({ userId: apiTokens.userId, tokenId: apiTokens.id, canSchedule: apiTokens.canSchedule, canPublish: apiTokens.canPublish, canDelete: apiTokens.canDelete });
  const r = rows[0];
  return r ? { userId: r.userId, tokenId: r.tokenId, scopes: scopesOf(r) } : null;
}

/**
 * Authenticate an agent request. Bearer only: cookies are deliberately ignored, so these routes need no CSRF
 * checks (a browser never attaches an Authorization header cross-site on its own).
 * Failed attempts are rate limited per IP. Throws UnauthorizedError (401) or RateLimitedError (429).
 */
export async function requireAgent(db: DB, req: Request): Promise<AgentAuth> {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  const auth = m ? await resolveApiToken(db, m[1]) : null;
  if (!auth) {
    await limitNamed(db, "agentAuthFail", clientIp(req));
    throw new UnauthorizedError();
  }
  return auth;
}

/** requireAgent for routes that only need the user (e.g. the x402 purchase route). */
export async function requireAgentUserId(db: DB, req: Request): Promise<string> {
  return (await requireAgent(db, req)).userId;
}
