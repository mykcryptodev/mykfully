"use client";

import type { XUser } from "@/lib/x/types";
import { MEDIA_CHUNK_SIZE, type MediaAttachment } from "@/lib/media-types";

export type DraftStatus = "draft" | "scheduled" | "publishing" | "published" | "failed";
export type ThreadPost = { id: string; text: string; media?: MediaAttachment[]; tweetId?: string | null };
type DraftPostInput = { id: string; text: string; media?: Pick<MediaAttachment, "id" | "altText">[] };

export type Draft = {
  id: string;
  userId: string;
  posts: ThreadPost[];
  status: DraftStatus;
  scheduledAt: string | null;
  publishedAt: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Me = {
  id: string;
  username: string;
  name: string;
  profileImageUrl: string | null;
  verifiedType: string | null;
  timezone: string;
  credits: number;
  isAdmin: boolean;
  needsReconnect: boolean;
  xUserId: string;
};

export type CreditKind = "signup" | "grant" | "revoke" | "spend" | "refund" | "purchase";

export type LedgerEntry = {
  id: string;
  delta: number;
  balanceAfter: number;
  kind: CreditKind;
  reason: string | null;
  ref: string | null;
  unmetered: boolean;
  createdAt: string;
};

export type CreditCosts = {
  post: number;
  postWithUrl: number;
  userRead: number;
  mediaUpload: number;
  mediaMetadata: number;
};

/** Optional "buy credits with USDC" (x402) feature, from GET /api/credits. `enabled: false` unless the instance configured it. */
export type PurchaseInfo = {
  enabled: boolean;
  network: "base" | "base-sepolia" | null;
  chainId: number | null;
  payTo: string | null;
  asset: string | null;
  packs: { id: string; usd: number; credits: number }[];
};

export type CreditsInfo = { balance: number; isAdmin: boolean; costs: CreditCosts; ledger: LedgerEntry[]; purchase?: PurchaseInfo };

export type AdminUser = {
  id: string;
  username: string;
  name: string;
  profileImageUrl: string | null;
  credits: number;
  isAdmin: boolean;
  spent7d: number;
  spent30d: number;
  createdAt: string;
  lastSeen: string | null;
};

export type { XUser };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Machine-readable code from the JSON body (e.g. "insufficient_credits", "rate_limited"). */
    public code: string | null = null,
    /** Any other fields of the JSON error body (e.g. `needed`, `balance`, `retryAfter`). */
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** JSON fetch; redirects to /login on 401 and throws ApiError on non-2xx. */
export async function apiFetch<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    credentials: "same-origin",
  });
  if (res.status === 401) {
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      window.location.href = "/login";
    }
    throw new ApiError(401, "Not signed in");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      (data && typeof data.error === "string" && data.error) ||
      (data?.issues?.[0]?.message as string | undefined) ||
      `Request failed (${res.status})`;
    const extra: Record<string, unknown> = data && typeof data === "object" ? { ...data } : {};
    const code = extra.code;
    delete extra.error;
    delete extra.code;
    if (extra.retryAfter == null) {
      const ra = Number(res.headers.get("Retry-After"));
      if (Number.isFinite(ra) && ra > 0) extra.retryAfter = ra;
    }
    throw new ApiError(res.status, msg, typeof code === "string" ? code : null, extra);
  }
  return data as T;
}

export function mediaUrl(id: string): string {
  return `/api/media/${encodeURIComponent(id)}`;
}

function encodeMediaChunk(chunk: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(chunk);
  });
}

async function uploadMedia(
  file: File,
  onProgress?: (percentage: number) => void,
  signal?: AbortSignal,
): Promise<MediaAttachment> {
  const { attachment } = await apiFetch<{ attachment: MediaAttachment }>("/api/media", {
    method: "POST",
    json: { name: file.name, contentType: file.type, size: file.size },
    signal,
  });
  for (let offset = 0; offset < file.size; offset += MEDIA_CHUNK_SIZE) {
    signal?.throwIfAborted();
    const chunk = file.slice(offset, offset + MEDIA_CHUNK_SIZE);
    const data = await encodeMediaChunk(chunk);
    const sendChunk = () => apiFetch<{ uploadedSize: number }>(mediaUrl(attachment.id), {
      method: "PATCH",
      json: { offset, data },
      signal,
    });
    const { uploadedSize } = await sendChunk().catch((error: unknown) => {
      if (signal?.aborted || !(error instanceof TypeError || (error instanceof ApiError && error.status >= 500))) {
        throw error;
      }
      return sendChunk();
    });
    if (uploadedSize !== offset + chunk.size) {
      throw new ApiError(409, "The upload was interrupted. Try attaching the file again.");
    }
    onProgress?.(Math.round((uploadedSize / file.size) * 100));
  }
  return attachment;
}

export const api = {
  me: () => apiFetch<{ user: Me }>("/api/me"),
  setTimezone: (timezone: string) => apiFetch<{ user: Me }>("/api/me", { method: "PATCH", json: { timezone } }),
  logout: () => fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }),
  listDrafts: (status?: DraftStatus) =>
    apiFetch<{ drafts: Draft[] }>(status ? `/api/drafts?status=${status}` : "/api/drafts"),
  getDraft: (id: string) => apiFetch<{ draft: Draft }>(`/api/drafts/${id}`),
  createDraft: (posts: DraftPostInput[]) =>
    apiFetch<{ draft: Draft }>("/api/drafts", { method: "POST", json: { posts } }),
  updateDraft: (id: string, patch: { posts?: DraftPostInput[]; scheduledAt?: string | null }) =>
    apiFetch<{ draft: Draft }>(`/api/drafts/${id}`, { method: "PATCH", json: patch }),
  deleteDraft: (id: string) => apiFetch<{ ok: true }>(`/api/drafts/${id}`, { method: "DELETE" }),
  publish: (id: string) => apiFetch<{ draft: Draft }>(`/api/drafts/${id}/publish`, { method: "POST" }),
  uploadMedia,
  searchMentions: (q: string, signal?: AbortSignal) =>
    apiFetch<{ users: XUser[]; source: string; creditsExhausted?: boolean }>(
      `/api/mentions/search?q=${encodeURIComponent(q)}`,
      { signal },
    ),
  getCredits: () => apiFetch<CreditsInfo>("/api/credits"),
  adminUsers: () => apiFetch<{ users: AdminUser[] }>("/api/admin/users"),
  adminLedger: (userId: string) =>
    apiFetch<{ ledger: LedgerEntry[] }>(`/api/admin/users/${encodeURIComponent(userId)}/ledger`),
  adminGrant: (userId: string, delta: number, reason: string) =>
    apiFetch<{ balance: number }>("/api/admin/credits", { method: "POST", json: { userId, delta, reason } }),
};

/** 1 credit ≈ $0.001 of X API spend. */
export function creditsToUsd(credits: number): string {
  const usd = credits / 1000;
  return `~$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: usd < 1 && usd > 0 ? 3 : 2 })}`;
}

export function formatCredits(n: number): string {
  return n.toLocaleString("en-US");
}

/** Friendly toast text for credit / rate-limit / cap errors; null when the error isn't one of those. */
export function creditErrorMessage(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  if (e.status === 402 || e.code === "insufficient_credits") {
    const needed = Number(e.extra.needed);
    const balance = Number(e.extra.balance);
    return Number.isFinite(needed) && Number.isFinite(balance)
      ? `Not enough credits (need ${formatCredits(needed)}, have ${formatCredits(balance)}). Ask the admin for more.`
      : "Not enough credits. Ask the admin for more.";
  }
  if (e.status === 429 || e.code === "rate_limited") {
    const s = Number(e.extra.retryAfter);
    return Number.isFinite(s) && s > 0
      ? `Too many requests — try again in ${s < 60 ? `${Math.ceil(s)}s` : `${Math.ceil(s / 60)} min`}.`
      : "Too many requests — try again shortly.";
  }
  if (e.status === 503 || e.code === "credit_cap_reached")
    return "This instance hit its daily credit cap. Try again later.";
  if (e.code === "reconnect_required") return "Your X connection expired. Reconnect X to keep publishing.";
  return null;
}

export function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
