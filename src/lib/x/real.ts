import { XApiError, XSearchUnavailableError, type XClient, type XTokenSet, type XUser } from "./types";

export const X_API_BASE = "https://api.x.com/2";
export const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
const TOKEN_TIMEOUT_MS = 15_000;

/**
 * Token-endpoint failure. Deliberately carries only the HTTP status and X's short `error` code — never the
 * response body or request params, which could contain tokens/codes.
 */
export class XTokenError extends Error {
  constructor(
    public status: number,
    public code: string | null,
    /** Used only for classification (see isDeadRefreshToken); never logged or put in `message`. */
    private readonly description: string | null = null,
  ) {
    super(`X token endpoint ${status}${code ? ` (${code})` : ""}`);
    this.name = "XTokenError";
  }

  /** X's answer when a refresh token is revoked, expired, or already rotated. */
  get isDeadRefreshToken(): boolean {
    if (this.status !== 400) return false;
    if (this.code === "invalid_grant") return true;
    return this.code === "invalid_request" && /refresh[ _]?token/i.test(this.description ?? "");
  }
}

function safeCode(v: unknown): string | null {
  return typeof v === "string" && /^[a-z_]{1,64}$/i.test(v) ? v : null;
}

type TokenResponse = {
  token_type: string;
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

/**
 * POST to the X OAuth2 token endpoint. Confidential clients use Basic auth (client_id omitted from body).
 * Errors are XTokenError (status + code only); network failures/timeouts are rethrown with a generic message.
 */
export async function xTokenRequest(
  params: Record<string, string>,
  client: { clientId: string; clientSecret: string | null },
): Promise<XTokenSet> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (client.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`;
  } else {
    body.set("client_id", client.clientId);
  }
  let res: Response;
  try {
    res = await fetch(X_TOKEN_URL, {
      method: "POST",
      headers,
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "Error";
    throw new Error(`X token endpoint unreachable (${name})`);
  }
  const text = await res.text();
  if (!res.ok) {
    let code: string | null = null;
    let description: string | null = null;
    try {
      const j = JSON.parse(text) as { error?: unknown; error_description?: unknown };
      code = safeCode(j.error);
      description = typeof j.error_description === "string" ? j.error_description.slice(0, 300) : null;
    } catch {
      /* non-JSON body */
    }
    const err = new XTokenError(res.status, code, description);
    console.error(`[x/token] ${err.message}`);
    throw err;
  }
  let t: TokenResponse;
  try {
    t = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error("X token endpoint returned invalid JSON");
  }
  if (!t.access_token) throw new Error("X token endpoint returned no access_token");
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (t.expires_in ?? 7200) * 1000),
    scope: t.scope ?? null,
  };
}
const USER_FIELDS = "profile_image_url,verified_type,subscription_type,description,public_metrics";

type RawUser = {
  id: string;
  username: string;
  name: string;
  profile_image_url?: string;
  verified_type?: string;
  subscription_type?: string; // "Basic" | "Premium" | "PremiumPlus" | "None"
  description?: string;
  public_metrics?: { followers_count?: number };
};

/**
 * `verifiedType` column carries the long-post signal: "premium" when the account has a
 * Premium / PremiumPlus subscription, otherwise X's verified_type (blue/business/government/none).
 */
export function deriveVerifiedType(u: Pick<RawUser, "verified_type" | "subscription_type">): string | null {
  if (u.subscription_type === "Premium" || u.subscription_type === "PremiumPlus") return "premium";
  return u.verified_type ?? null;
}

export function mapUser(u: RawUser): XUser {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    profileImageUrl: u.profile_image_url ? u.profile_image_url.replace("_normal", "_bigger") : null,
    verifiedType: deriveVerifiedType(u),
    description: u.description ?? null,
    followersCount: u.public_metrics?.followers_count ?? null,
  };
}

export function createRealXClient(accessToken: string): XClient {
  async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: string }> {
    const res = await fetch(`${X_API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      cache: "no-store",
    });
    return { status: res.status, body: await res.text() };
  }

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const { status, body } = await call(path, init);
    if (status < 200 || status >= 300) throw new XApiError(status, body);
    return (body ? JSON.parse(body) : {}) as T;
  }

  return {
    async me() {
      const r = await json<{ data: RawUser }>(`/users/me?user.fields=${USER_FIELDS}`);
      return mapUser(r.data);
    },

    async postTweet(text, replyToId) {
      const payload: Record<string, unknown> = { text };
      if (replyToId) payload.reply = { in_reply_to_tweet_id: replyToId };
      const r = await json<{ data: { id: string } }>(`/tweets`, { method: "POST", body: JSON.stringify(payload) });
      return { id: r.data.id };
    },

    async lookupUsernames(usernames) {
      const names = usernames.map((u) => u.replace(/^@/, "")).filter((u) => /^[A-Za-z0-9_]{1,15}$/.test(u));
      if (names.length === 0) return [];
      // Unknown handles come back under `errors`, not as a non-2xx.
      const r = await json<{ data?: RawUser[] }>(
        `/users/by?usernames=${encodeURIComponent(names.slice(0, 100).join(","))}&user.fields=${USER_FIELDS}`,
      );
      return (r.data ?? []).map(mapUser);
    },

    async searchUsers(query, max = 8) {
      const q = query.trim().slice(0, 50); // X: query must be 1-50 chars
      if (!q) return [];
      const maxResults = Math.min(Math.max(max, 1), 100);
      const { status, body } = await call(
        `/users/search?query=${encodeURIComponent(q)}&max_results=${maxResults}&user.fields=${USER_FIELDS}`,
      );
      if (status === 403 || status === 404) throw new XSearchUnavailableError();
      if (status === 401 && /tier|enroll|access level|product|plan|unsupported/i.test(body)) {
        throw new XSearchUnavailableError();
      }
      if (status < 200 || status >= 300) throw new XApiError(status, body);
      const r = (body ? JSON.parse(body) : {}) as { data?: RawUser[] };
      return (r.data ?? []).slice(0, max).map(mapUser);
    },
  };
}
