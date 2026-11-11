export type XUser = {
  id: string;
  username: string;
  name: string;
  profileImageUrl?: string | null;
  verifiedType?: string | null;
  description?: string | null;
  followersCount?: number | null;
};

export type XTokenSet = {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt: Date;
  scope?: string | null;
};

/** Thin wrapper over the X API v2, authenticated as a specific user. */
export interface XClient {
  me(): Promise<XUser>;
  /** Post a tweet; if replyToId is set, it is posted as a reply (thread chaining). Returns new tweet id. */
  postTweet(text: string, replyToId?: string | null): Promise<{ id: string }>;
  /** Exact-handle lookup(s). Unknown handles are omitted. */
  lookupUsernames(usernames: string[]): Promise<XUser[]>;
  /** Fuzzy user search. Throws XSearchUnavailableError if the API tier doesn't allow it. */
  searchUsers(query: string, max?: number): Promise<XUser[]>;
}

export class XSearchUnavailableError extends Error {
  constructor(msg = "X user search is not available on this API tier") {
    super(msg);
  }
}

export class XApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`X API ${status}: ${body.slice(0, 500)}`);
  }
}
