import { XApiError, XSearchUnavailableError, type XClient, type XUser } from "./types";

export const X_API_BASE = "https://api.x.com/2";
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
