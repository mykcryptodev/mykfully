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

export type XMediaRequest =
  | { type: "image"; media: Blob }
  | { type: "initialize"; contentType: "image/gif" | "video/mp4"; size: number }
  | { type: "append"; id: string; media: Blob; index: number }
  | { type: "finalize" | "status"; id: string }
  | { type: "altText"; id: string; text: string };

export type XMediaResponse = {
  id?: string;
  processing_info?: {
    state: "pending" | "in_progress" | "succeeded" | "failed";
    check_after_secs?: number;
  };
};

/** Thin wrapper over the X API v2, authenticated as a specific user. */
export interface XClient {
  me(): Promise<XUser>;
  /** Post a tweet; if replyToId is set, it is posted as a reply (thread chaining). Returns new tweet id. */
  postTweet(text: string, replyToId?: string | null, mediaIds?: string[], signal?: AbortSignal): Promise<{ id: string }>;
  /** A single request to the X media upload or metadata endpoints. */
  requestMedia(request: XMediaRequest, signal?: AbortSignal): Promise<XMediaResponse>;
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
